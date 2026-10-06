/**
 * The Files page's right-hand pane: reads the selected file once and renders
 * it by kind. Markdown renders rather than showing its source — that's the
 * point of the feature; the raw text is one Edit click away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarActions, MessageBarBody, Spinner, Tab, TabList, Text,
} from '@fluentui/react-components';
import { DocumentText48Regular, Edit20Regular, Save20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { CodeEditor } from './CodeEditor.tsx';
import { EmptyState } from './EmptyState.tsx';
import { countOccurrences } from '../markdown/find.ts';
import { FindBar } from '../markdown/FindBar.tsx';
import { Markdown } from '../markdown/Markdown.tsx';
import { MAX_IMAGE_BYTES } from '../markdown/MarkdownImage.tsx';
import type { DocResolution, FindMatchCounts } from '../markdown/types.ts';
import { useFileSystem } from '../files/fs-context.tsx';
import {
  detectKind, isTextKind, languageForPath, mimeTypeForPath, MAX_PREVIEW_BYTES, previewCapFor, type FileKind,
} from '../files/file-kind.ts';
import { highlightCode } from '../files/highlight.ts';
import { useGlobalShortcut } from '../lib/use-global-shortcut.ts';
import { PdfView } from '../pdf/PdfView.tsx';
import { formatBytes } from '../shared/format.ts';
import { errorMessage } from '../lib/error-message.ts';

interface Loaded {
  path: string;
  kind: FileKind;
  /** Decoded text for markdown/text; undefined for image, PDF and binary. */
  text?: string;
  /** Object URL for images; revoked when the preview moves on. */
  imageUrl?: string;
  /** The file's bytes, for a PDF: pdf.js parses them itself. */
  bytes?: Uint8Array;
  size: number;
  mtimeMs: number;
}

type View = 'rendered' | 'source';

// Sticky for the session rather than per file: someone who wants to read
// source usually wants it for the next file too. Module scope, not state —
// neither host page keys <FilePreview>, so a selection change is just a
// re-render and state would have survived that fine. What state would not
// survive is leaving this page (unmounting FilePreview) and coming back —
// module scope is what makes the preference outlast that.
let lastView: View = 'rendered';

/**
 * How close to the bottom still counts as "reading the end", and so as
 * wanting to be carried along by whatever is being appended. Generous
 * enough to survive a fractional scroll offset or a partly-visible last
 * line, small enough that a reader who has deliberately scrolled up stays
 * where they put themselves.
 */
const STICK_TO_BOTTOM_PX = 40;

/** Nothing found (yet): the starting counts, and what closing find restores. */
const NO_MATCHES: FindMatchCounts = { total: 0, unreachable: 0 };

/**
 * Find in document. Window-level rather than pane-level: the realistic
 * sequence is to click a file in the tree and then press Ctrl/Cmd-F, and a
 * handler on the preview only ever fires once focus is already inside it.
 * The webview has no native find to fall back on, so a shortcut that needs
 * the reader to guess where to click first is a shortcut nobody finds.
 */
const FIND_IN_DOCUMENT = { key: 'f', mod: true } as const;

/** Test-only: the module-scope view preference otherwise outlives every test. */
export function resetPreviewViewForTests(): void {
  lastView = 'rendered';
}

/**
 * How links and images in a markdown document resolve. Supplied by the page
 * that owns the navigation model — the workspace tree on the Files page, the
 * run manifest on the Artifacts tab — because only it knows what a relative
 * path is allowed to reach.
 */
export interface DocContext {
  resolve: (target: string) => DocResolution | null;
  onNavigate: (path: string) => void;
  openExternal?: (url: string) => void;
}

export interface FilePreviewProps {
  path: string | null;
  onDirtyChange: (dirty: boolean) => void;
  /** New-file flow: open straight in edit mode, since there's nothing to render. */
  startInEditMode?: boolean;
  /** Bumped by the page to force a re-read (external change, post-rename). */
  reloadToken?: number;
  /**
   * Absent → the document still renders, but its links are inert and its
   * relative images show a placeholder. That is the honest degradation: a
   * link with nowhere to go should not look like one.
   */
  docContext?: DocContext;
  /**
   * Follow the open file as something else writes it. Off by default: a
   * watcher is an inotify handle (or a poll), and a page that knows nothing
   * can change it — a finished run's artifacts — should not pay for one.
   */
  live?: boolean;
}

export function FilePreview({
  path, onDirtyChange, startInEditMode, reloadToken, docContext, live,
}: FilePreviewProps) {
  const fs = useFileSystem();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tooLarge, setTooLarge] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ diskText: string; diskMtimeMs: number } | null>(null);
  const [diskChanged, setDiskChanged] = useState(false);
  /**
   * Why the last Reload could not be applied, when it could not.
   *
   * reload() has three paths that give up and return — the file no longer
   * reads, it grew past MAX_PREVIEW_BYTES, or it stopped being text. Each
   * leaves `diskChanged` set, so without this the notice's Reload button
   * stays there and visibly does nothing when pressed. `retryable` says
   * whether pressing it again could ever help.
   */
  const [reloadBlocked, setReloadBlocked] = useState<{ reason: string; retryable: boolean } | null>(null);
  const [view, setView] = useState<View>(lastView);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCounts, setFindCounts] = useState<FindMatchCounts>(NO_MATCHES);
  const [findIndex, setFindIndex] = useState(0);
  // Bumped on every Ctrl/Cmd-F so the bar refocuses even when already open.
  const [findFocusToken, setFindFocusToken] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dirty = editing && loaded !== null && draft !== (loaded.text ?? '');
  // A ref, not a dependency: onDirtyChange is a fresh closure from the page on
  // every render, and depending on it directly would re-fire this effect (and
  // re-notify the page) on every parent re-render even though dirty hasn't changed.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);

  useEffect(() => {
    setLoaded(null);
    setTooLarge(null);
    setError(null);
    setEditing(false);
    setDraft('');
    setSaveError(null);
    setConflict(null);
    setDiskChanged(false);
    setReloadBlocked(null);
    // A find is about the document it was opened on; carrying the query to
    // the next file would leave the bar counting somebody else's matches.
    setFindOpen(false);
    setFindQuery('');
    setFindCounts(NO_MATCHES);
    if (!path) return;

    let cancelled = false;
    let objectUrl: string | undefined;
    setLoading(true);

    void (async () => {
      try {
        const info = await fs.stat(path);
        // An image or a PDF gets the larger cap: it is rendered, not decoded
        // as text, and a screenshot or a spec attached to a run is often past
        // the text cap.
        if (info.size > previewCapFor(path)) {
          if (!cancelled) setTooLarge(info.size);
          return;
        }
        const bytes = await fs.readFile(path);
        if (cancelled) return;
        const kind = detectKind(path, bytes);
        if (kind === 'image') {
          // An object URL rather than a base64 data: URI — no copy of the
          // bytes as a string, and it's revoked the moment we move on. The
          // type matters: an <img> content-sniffs raster formats but refuses
          // to render an SVG that isn't typed image/svg+xml.
          objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: mimeTypeForPath(path) }),
          );
          setLoaded({ path, kind, imageUrl: objectUrl, size: info.size, mtimeMs: info.mtimeMs });
          return;
        }
        if (kind === 'pdf') {
          setLoaded({ path, kind, bytes, size: info.size, mtimeMs: info.mtimeMs });
          return;
        }
        const text = isTextKind(kind) ? new TextDecoder().decode(bytes) : undefined;
        setLoaded({ path, kind, text, size: info.size, mtimeMs: info.mtimeMs });
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, fs, reloadToken]);

  // Mirrors `loaded` for the identity-stable callbacks below, and for
  // reload()'s re-checks after an await.
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  /**
   * Re-reads the open file in place: same `loaded` identity semantics as the
   * load effect, but without the spinner, the edit-mode reset or the view
   * reset — this is a document growing under the reader, not a new document.
   */
  const reload = useCallback(async (options?: { overwriteDraft?: boolean }) => {
    if (!path) return;
    // Measured before the swap, applied after it: whether the reader was
    // parked at the end decides between following the new text down and
    // staying exactly where they were.
    const scroller = scrollRef.current;
    const wasAtBottom = scroller
      ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= STICK_TO_BOTTOM_PX
      : false;
    const previousTop = scroller?.scrollTop ?? 0;

    // Only ever set while the "changed on disk" notice is up: that is the
    // one situation where a reload that gives up is visible as a button
    // doing nothing. The automatic (undirty) reload path has no notice and
    // no button, and a reason left behind there would surface later against
    // a completely different change.
    const blocked = (reason: string, retryable: boolean) => {
      if (diskChangedRef.current) setReloadBlocked({ reason, retryable });
    };

    try {
      const info = await fs.stat(path);
      if (info.size > MAX_PREVIEW_BYTES) {
        blocked('It is now too large to preview, so what is above is the last version that fit.', false);
        return;
      }
      const bytes = await fs.readFile(path);
      const kind = detectKind(path, bytes);
      // Only text refreshes in place. A file that turned binary (or into an
      // image) mid-write is a different document; leave it to a re-open. So
      // is a PDF, even one that was a PDF all along: a run rewriting it would
      // be caught half-written, which pdf.js can't parse, and re-selecting
      // the file picks up the finished one.
      if (!isTextKind(kind)) {
        blocked('It is no longer a text file, so what is above is the last text it held.', false);
        return;
      }
      const text = new TextDecoder().decode(bytes);
      // Two awaits have passed since this reload was decided on. In that
      // window — an RPC round trip on the artifact port — the reader may
      // have started typing, or moved to another file entirely, so every
      // write below re-checks who it is writing to.
      const stillOpen = loadedRef.current?.path === path;
      const unchanged = stillOpen && loadedRef.current?.text === text;

      setLoaded(current => {
        if (!current || current.path !== path) return current;
        // Identical bytes must not re-render the document. The Tauri watcher
        // matches loosely on the parent directory (a basename fallback), so
        // an unrelated write in a busy folder arrives here as a change to
        // this file — and re-rendering for it would collapse an
        // open <details>, drop the reader's selection and restart image
        // loads. The mtime still moves: the save-time write guard compares
        // against it, and letting it go stale would raise phantom conflicts.
        if (current.text === text) {
          return current.mtimeMs === info.mtimeMs && current.size === info.size
            ? current
            : { ...current, size: info.size, mtimeMs: info.mtimeMs };
        }
        return { ...current, text, size: info.size, mtimeMs: info.mtimeMs };
      });

      // The draft follows the reloaded text, so that an untouched editor does
      // not read as dirty against the newly loaded text. Not when the reader
      // has started editing since this read went out, though: an automatic
      // reload only ever *begins* with no unsaved edit to lose (the watcher
      // defers to the notice otherwise), but one can begin during the read.
      // `overwriteDraft` is the exception — the notice's Reload button is the
      // reader asking for the disk version in as many words.
      if (stillOpen && (options?.overwriteDraft || !dirtyRef.current)) setDraft(text);
      if (stillOpen) {
        setDiskChanged(false);
        setReloadBlocked(null);
      }
      // Nothing moved, so nothing to hold: yanking the scroll for a write
      // that did not touch this document is exactly the disturbance the
      // identical-bytes check above exists to avoid.
      if (unchanged) return;
    } catch {
      // A file being rewritten can vanish for an instant. Keep showing what
      // is already there rather than surfacing an error; the next event
      // brings the new contents. Retryable: the next attempt may well
      // succeed, so the button stays.
      blocked('It could not be read just now — try again.', true);
      return;
    }

    // After React has painted the new text, not before: the bottom is only
    // where the *new* content ends, and restoring against the old layout
    // would be undone by the swap.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      // Re-checked here, not just before the swap: `scrollRef` follows the
      // pane, so by the time a late read gets its frame the ref points at
      // the *newly opened* file's scroll container — which would then be
      // scrolled to an offset measured in a document nobody is reading.
      if (!el || loadedRef.current?.path !== path) return;
      el.scrollTop = wasAtBottom ? el.scrollHeight - el.clientHeight : previousTop;
    });
  }, [fs, path]);

  /**
   * Asks whether the file differs from what this pane loaded, and raises (or
   * takes down) the notice accordingly — without touching `loaded`.
   *
   * Every dirty-draft path goes through here: the watcher's events, and the
   * closing read when `live` goes false. Swapping under a dirty draft would
   * advance `loaded.mtimeMs` and disarm the save-time write guard for the
   * very write it just ingested, so the swap has to be skipped; but skipping
   * everything would leave the reader on stale text with no warning. This is
   * the half that is safe: the notice, and nothing else.
   */
  const noticeIfChanged = useCallback(async () => {
    if (!path) return;
    /** Only for the file still on screen: an await may have outlived it. */
    const note = (changed: boolean) => {
      if (loadedRef.current?.path === path) setDiskChanged(changed);
    };
    try {
      const info = await fs.stat(path);
      // These two cases can't be compared, but they are unmistakably changes:
      // the pane is showing text that the file no longer holds. reload() is
      // what then explains why it cannot act on the notice ("too large",
      // "no longer a text file").
      if (info.size > MAX_PREVIEW_BYTES) return note(true);
      const bytes = await fs.readFile(path);
      const kind = detectKind(path, bytes);
      if (!isTextKind(kind)) return note(true);
      // Both directions: a file that has come back to matching what the pane
      // loaded (an editor writing, then reverting; a checkout that put the
      // original back) takes the notice down again rather than leaving it
      // standing over a difference that no longer exists.
      note(loadedRef.current?.text !== new TextDecoder().decode(bytes));
    } catch {
      // As in reload(): a file caught mid-write is not worth an error.
    }
  }, [fs, path]);

  // Read through refs, not dependencies: `reload` closes over the draft and
  // `dirty` changes on every keystroke, so depending on either directly
  // would tear down and rebuild the watcher — an inotify handle, or a poll —
  // each time a character is typed.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const noticeIfChangedRef = useRef(noticeIfChanged);
  noticeIfChangedRef.current = noticeIfChanged;
  const diskChangedRef = useRef(diskChanged);
  diskChangedRef.current = diskChanged;

  useEffect(() => {
    if (!live || !path) return;
    let stop: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const unwatch = await fs.watchFile(path, () => {
          // Never overwrite an edit in progress — say so, and let the reader
          // decide. The save-time conflict dialog is still there as the last
          // line of defence; this is the earlier, gentler version of it.
          //
          // Both branches read the file before they act on the event, because
          // an event is not evidence that anything changed: tauri-fs matches
          // by basename within the parent directory, and a rewrite-in-place
          // (git checkout, a formatter, the echo of our own save) fires one
          // for bytes that are still exactly what this pane loaded. Raising
          // the notice from the event alone told a reader who was the only
          // one touching the file that it had changed underneath them, and
          // offered to throw their edits away for it.
          if (dirtyRef.current) void noticeIfChangedRef.current();
          else void reloadRef.current();
        });
        // The effect may have been cleaned up while the watch was being set
        // up; unwatch is safe to call after the fact.
        if (cancelled) unwatch();
        else stop = unwatch;
      } catch {
        // Quietly, and deliberately: watchFile can reject (a path that fails
        // the traversal check, or the plugin refusing the parent directory),
        // and a pane that is merely not live is still a correct pane — it
        // shows what it read, and the reader can re-select to refresh. An
        // error bar over a document they can already read would be noise
        // about something they cannot act on. What is *not* acceptable is
        // letting this surface as an unhandled rejection in the webview.
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [fs, path, live]);

  /**
   * One closing read when the run finishes.
   *
   * `live` goes false the moment the run does, and the watch is torn down
   * with it — but ArtifactFileSystem polls on an interval, so anything
   * written inside that last window was never picked up. Without this the
   * pane would show content up to a poll stale, with no warning and no way
   * to refresh short of re-selecting the file, at exactly the moment the
   * reader turns to the finished result.
   *
   * Only on the true->false edge: not on mount (the load effect has just
   * read the file), and not when the path changes under a steady `live`.
   */
  const wasLiveRef = useRef(false);
  useEffect(() => {
    // A dirty draft gets the notice instead of the swap. Advancing
    // `loaded.mtimeMs` behind the reader's back would quietly disarm the
    // save-time write guard for the very write we just took — but saying
    // nothing at all would strand them on stale text with no warning and no
    // further event coming, which is the one outcome the notice exists for.
    if (wasLiveRef.current && !live && path) {
      if (dirtyRef.current) void noticeIfChangedRef.current();
      else void reloadRef.current();
    }
    wasLiveRef.current = Boolean(live);
  }, [live, path]);

  /**
   * Reads the bytes behind a relative image in a rendered document.
   *
   * Identity-stable (it only ever depends on the port), because MarkdownImage
   * keys its load effect on this function: a fresh closure per render would
   * re-fire the read, revoke the object URL and re-create it on every parent
   * render.
   *
   * The size cap is checked on the stat rather than on the bytes. Refusing
   * after the read would still have pulled the whole file across the IPC
   * boundary just to discard it, and a rejection here is the designed path —
   * MarkdownImage renders its placeholder for one.
   */
  const loadImage = useCallback(async (imagePath: string): Promise<Uint8Array> => {
    const info = await fs.stat(imagePath);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image is too large to display (${formatBytes(info.size)}).`);
    }
    return fs.readFile(imagePath);
  }, [fs]);

  // Auto-entry into edit mode must be one-shot per opened file, not per
  // `loaded` object identity: `loaded` is also replaced by applySave (on
  // Save) and by the conflict dialog's Reload handler, and the new-file
  // flow keeps `startInEditMode` true across a save. Keying on the object
  // identity re-triggered this effect after every save/reload and flipped
  // straight back into the editor. Keying on path+reloadToken instead means
  // "fresh load of this specific file" — which fires once per genuinely new
  // load and never again for the same one, however many times `loaded` is
  // replaced under it.
  const autoEditedForRef = useRef<string | null>(null);
  useEffect(() => {
    const loadKey = `${path ?? ''}|${reloadToken ?? ''}`;
    if (startInEditMode && loaded && autoEditedForRef.current !== loadKey) {
      autoEditedForRef.current = loadKey;
      setEditing(true);
      setDraft(loaded.text ?? '');
    }
  }, [loaded, startInEditMode, path, reloadToken]);

  const applySave = useCallback(async (contents: string) => {
    if (!path) return;
    try {
      await fs.writeTextFile(path, contents);
      const info = await fs.stat(path);
      setLoaded(current => (current ? { ...current, text: contents, size: info.size, mtimeMs: info.mtimeMs } : current));
      setEditing(false);
      setConflict(null);
      setSaveError(null);
      // Whatever changed underneath us is moot: the file now holds our text.
      setDiskChanged(false);
      setReloadBlocked(null);
    } catch (e) {
      setSaveError(errorMessage(e));
    }
  }, [fs, path]);

  const save = useCallback(async () => {
    if (!path || !loaded) return;
    // Stale-write guard: something else (a run, an editor) may have written
    // this file since it was opened. Never clobber that silently.
    try {
      const info = await fs.stat(path);
      if (info.mtimeMs !== loaded.mtimeMs) {
        const bytes = await fs.readFile(path);
        setConflict({ diskText: new TextDecoder().decode(bytes), diskMtimeMs: info.mtimeMs });
        return;
      }
    } catch (e) {
      setSaveError(errorMessage(e));
      return;
    }
    await applySave(draft);
  }, [applySave, draft, fs, loaded, path]);

  const startEdit = useCallback(() => {
    setEditing(true);
    setDraft(loadedRef.current?.text ?? '');
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setSaveError(null);
    // A change deferred while the draft was dirty is safe to take now that
    // the draft is gone — and there may never be another event to carry it,
    // if the run that wrote the file has since finished.
    if (diskChangedRef.current) void reloadRef.current();
  }, []);

  /*
   * Find in document.
   *
   * The two views count differently and both are right. The rendered view
   * counts real <mark>s, which excludes fenced code — find.ts cannot mark it
   * (CodeBlock renders through dangerouslySetInnerHTML, so a <mark> there
   * would be counted but never shown). The source view has no hast tree to
   * mark at all, so it counts by scanning the text it is displaying — which
   * does include the fences, because they are on screen verbatim.
   *
   * That difference is reported, not smoothed over: Markdown also counts the
   * occurrences it had to skip, and the bar says "+N in code blocks" so the
   * number never quietly changes meaning between the two views.
   */
  const reportCounts = useCallback((next: FindMatchCounts) => {
    // Identity-stable, and it drops a no-op update: Markdown re-reports after
    // every render of the document, and a fresh object each time would
    // re-render this pane for a count that did not change.
    setFindCounts(current => (
      current.total === next.total && current.unreachable === next.unreachable ? current : next
    ));
  }, []);

  const sourceMatches = useMemo(() => (
    view === 'source' ? countOccurrences(loaded?.text ?? '', findQuery) : 0
  ), [view, findQuery, loaded?.text]);

  useEffect(() => {
    if (view === 'source') reportCounts({ total: sourceMatches, unreachable: 0 });
  }, [view, sourceMatches, reportCounts]);

  // A new query starts from the first match, not wherever the last one ended.
  useEffect(() => { setFindIndex(0); }, [findQuery]);

  // Clamped rather than corrected in an effect: the total moves under the
  // index (the query narrows, the document reloads mid-search), and an
  // out-of-range index would show "3/2" for the render before the fix.
  const findTotal = findCounts.total;
  const findActive = findTotal === 0 ? 0 : Math.min(findIndex, findTotal - 1);

  // ...and clamped in state as well, not only on the way to the screen. A
  // live document rewritten under an open find can shrink the total and then
  // grow it again; a stale index left behind would come back to life on the
  // second write and move the active match with no reader action at all.
  useEffect(() => {
    setFindIndex(current => (current < findTotal ? current : Math.max(findTotal - 1, 0)));
  }, [findTotal]);

  const step = useCallback((delta: 1 | -1) => {
    // Wraps in both directions: reaching the last match and pressing Enter
    // again should carry on from the top, not stop dead.
    setFindIndex(findTotal === 0 ? 0 : (findActive + delta + findTotal) % findTotal);
  }, [findActive, findTotal]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindCounts(NO_MATCHES);
  }, []);

  // The editor shows the raw text in a <textarea>, which has the webview's
  // own caret and no marks to step through — and leaving the bar up would
  // have it counting a document that is no longer the one on screen.
  useEffect(() => {
    if (editing) closeFind();
  }, [editing, closeFind]);

  // Both markdown views are searchable — the rendered one by its marks, the
  // source one by a text scan. The editor is not: it has the webview's own
  // caret, and Ctrl/Cmd-F there is left alone rather than swallowed.
  // Computed up here (rather than beside the markup that uses it) because
  // the shortcut below is a hook and hooks run before the early returns.
  const findable = loaded?.kind === 'markdown' && !editing;

  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindFocusToken(token => token + 1);
  }, []);
  // Subscribed only where there is a markdown document to search — and not
  // merely inert elsewhere. The hook preventDefaults every match, so a
  // shortcut that would do nothing here has to be absent rather than
  // silent, or Ctrl/Cmd-F over an image or a plain text file would be
  // swallowed by a pane that had no use for it.
  useGlobalShortcut(FIND_IN_DOCUMENT, openFind, findable);

  // Hooks must run before the early returns below, so the editor's controls
  // are assembled here rather than beside the buttons they drive.
  const hasEditableContent = loaded !== null
    && (loaded.kind === 'markdown' || loaded.kind === 'text');

  // Both host pages wrap this component in a `display: flex` pane so the
  // preview can fill it. Every one of these early returns is the pane's
  // *sole* child, so it is a flex item too — and a row-direction flex item's
  // default `align-self: stretch` would silently stretch each of these to
  // the pane's full height. For an <img> that also distorts its aspect ratio,
  // and since the pane is `overflow: hidden`, a tall image would lose its
  // scrollbar and simply clip. `alignSelf: 'flex-start'` opts every one of
  // these back into sizing to its own content, matching the pre-Task-9
  // layout; the image also gets `maxHeight`/`objectFit` so a tall one
  // shrinks to fit instead of needing to scroll (there is no scroll
  // container out here — that only exists on the editable/markdown path).
  const earlyReturnStyle = { alignSelf: 'flex-start' as const };
  if (!path) {
    return (
      <EmptyState icon={<DocumentText48Regular />}>Select a file to preview it.</EmptyState>
    );
  }
  if (error) {
    return (
      <MessageBar intent="error" style={earlyReturnStyle}>
        <MessageBarBody>Could not open this file: {error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (tooLarge !== null) {
    return <Text style={earlyReturnStyle}>Too large to preview ({formatBytes(tooLarge)}).</Text>;
  }
  if (loading || !loaded) return <Spinner size="tiny" label="Opening…" style={earlyReturnStyle} />;

  const editable = isTextKind(loaded.kind);
  if (!editable) {
    if (loaded.kind === 'pdf') {
      // Not held to earlyReturnStyle: a PDF fills the pane and scrolls
      // inside it, as the editable branch below does. PdfView's root is
      // that same flex item — and, as with the text, there is no Edit and
      // no Ctrl/Cmd-F (`findable` is false) over it.
      return <PdfView path={loaded.path} bytes={loaded.bytes ?? new Uint8Array()} />;
    }
    if (loaded.kind === 'binary') {
      return <Text style={earlyReturnStyle}>Binary file — {formatBytes(loaded.size)}. {loaded.path}</Text>;
    }
    return (
      <img
        src={loaded.imageUrl}
        alt={loaded.path}
        style={{ ...earlyReturnStyle, maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    );
  }

  const isMarkdown = loaded.kind === 'markdown';
  const showToggle = isMarkdown && !editing;

  return (
    <div
      // Escape, and the one case the window-level shortcut deliberately
      // declines: `isTypingTarget` sends Ctrl/Cmd-F back to whatever the
      // reader is typing into, and the find box is an <input>. Pressing it
      // again while the cursor is in the box means "search for something
      // else", so it has to be caught here. React's handler runs before the
      // window listener and calls preventDefault, which is what stops the
      // two from both firing everywhere else in the pane.
      onKeyDown={event => {
        if (!findable) return;
        if (findOpen && (event.ctrlKey || event.metaKey) && event.key === 'f') {
          event.preventDefault();
          openFind();
        } else if (event.key === 'Escape' && findOpen) {
          event.preventDefault();
          closeFind();
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, width: '100%', height: '100%', minHeight: 0 }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Text weight="semibold">{loaded.path}</Text>
        <div style={{ flex: 1 }} />
        {showToggle && (
          <TabList
            size="small"
            selectedValue={view}
            onTabSelect={(_event, data) => {
              const next = data.value as View;
              lastView = next;
              setView(next);
            }}
          >
            <Tab value="rendered">Rendered</Tab>
            <Tab value="source">Source</Tab>
          </TabList>
        )}
        {/* Beside the file they act on — the same place on both pages that
            host this pane. */}
        {editing ? (
          <>
            <Button appearance="primary" icon={<Save20Regular />} onClick={() => void save()}>Save</Button>
            <Button icon={<Dismiss20Regular />} onClick={cancelEdit}>Cancel</Button>
          </>
        ) : (
          <Button icon={<Edit20Regular />} onClick={startEdit}>Edit</Button>
        )}
      </div>

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>Could not save this file: {saveError}</MessageBarBody>
        </MessageBar>
      )}

      {diskChanged && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This file changed on disk while you were editing it.
            {reloadBlocked && ` ${reloadBlocked.reason}`}
          </MessageBarBody>
          {/*
            * Withdrawn once reloading is known to be impossible: a button
            * that has already failed for a reason that will not change is
            * worse than no button, since pressing it looks like nothing
            * happening. A retryable failure keeps it.
            */}
          {(reloadBlocked === null || reloadBlocked.retryable) && (
            <MessageBarActions>
              <Button size="small" onClick={() => void reload({ overwriteDraft: true })}>Reload</Button>
            </MessageBarActions>
          )}
        </MessageBar>
      )}

      {findOpen && findable && (
        <FindBar
          query={findQuery}
          total={findTotal}
          unreachable={findCounts.unreachable}
          activeIndex={findActive}
          // The source view counts by scanning text; there is nothing marked
          // there to step to, so the controls say so rather than moving a
          // counter over a document that never scrolls.
          canStep={view === 'rendered'}
          focusToken={findFocusToken}
          onQueryChange={setFindQuery}
          onStep={step}
          onClose={closeFind}
        />
      )}

      <div
        data-testid="preview-scroll"
        ref={scrollRef}
        // Focusable so a keyboard user can scroll it without needing to tab
        // into something inside first, and so a Ctrl/Cmd-F handler can
        // attach to it directly.
        tabIndex={0}
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        {editing ? (
          // Highlighted by the same highlight.js call, and the same language
          // map, as the Source view below — editing a file and reading it
          // should not be two different-looking things. CodeEditor owns its
          // own layout rather than a pile of overrides on Fluent's Textarea
          // (which fought this scroll container over its own max-height).
          <CodeEditor
            value={draft}
            onChange={setDraft}
            language={languageForPath(loaded.path)}
            onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                event.preventDefault();
                void save();
              }
            }}
          />
        ) : loaded.kind === 'markdown' && view === 'rendered' ? (
          <Markdown
            text={loaded.text ?? ''}
            resolve={docContext?.resolve}
            onNavigate={docContext?.onNavigate}
            openExternal={docContext?.openExternal}
            loadImage={loadImage}
            find={findOpen ? { query: findQuery, activeIndex: findActive, onMatchCount: reportCounts } : undefined}
          />
        ) : (
          <pre style={{ margin: 0 }} data-testid="preview-source">
            <code
              className="hljs"
              dangerouslySetInnerHTML={{ __html: highlightCode(loaded.text ?? '', languageForPath(loaded.path)) }}
            />
          </pre>
        )}
      </div>

      {conflict !== null && (
        // Mounted only while there's an actual conflict, not rendered-but-
        // closed: a closed Dialog is still a live Fluent Modalizer, and
        // stacking one under FilesPage's own guard dialog let tabster's
        // registration bookkeeping race under load, leaving the wrong
        // Modalizer's surface aria-hidden (see task-8-report.md).
        <Dialog open onOpenChange={(_event, data) => { if (!data.open) setConflict(null); }}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>This file changed on disk</DialogTitle>
              <DialogContent>
                Something else wrote to this file after you opened it — a run, or another editor.
                Overwrite it with your version, or reload theirs and lose your edits?
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => void applySave(draft)}>Overwrite</Button>
                <Button
                  onClick={() => {
                    if (!conflict) return;
                    setLoaded(current => (
                      current ? { ...current, text: conflict.diskText, mtimeMs: conflict.diskMtimeMs } : current
                    ));
                    setDraft(conflict.diskText);
                    setEditing(false);
                    setConflict(null);
                    setDiskChanged(false);
                    setReloadBlocked(null);
                  }}
                >
                  Reload
                </Button>
                <Button onClick={() => setConflict(null)}>Cancel</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}
