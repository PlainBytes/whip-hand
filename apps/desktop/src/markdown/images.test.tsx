import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown.tsx';

const PNG_BYTES = new TextEncoder().encode('fake-png-bytes');

describe('markdown images', () => {
  it('loads a relative image through the provided loader', async () => {
    const loadImage = vi.fn().mockResolvedValue(PNG_BYTES);
    render(
      <Markdown
        text="![diagram](./arch.png)"
        resolve={() => ({ path: '/ws/arch.png', kind: 'image' })}
        loadImage={loadImage}
      />,
    );
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith('/ws/arch.png'));
    const img = await screen.findByAltText('diagram');
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  it('leaves an http image src alone rather than routing it through the loader', async () => {
    const loadImage = vi.fn();
    render(
      <Markdown
        text="![remote](https://example.com/a.png)"
        resolve={() => ({ path: '/ws/a.png', kind: 'image' })}
        loadImage={loadImage}
      />,
    );
    expect(await screen.findByAltText('remote')).toHaveAttribute('src', 'https://example.com/a.png');
    expect(loadImage).not.toHaveBeenCalled();
  });

  it('shows a placeholder when the image cannot be resolved', async () => {
    render(<Markdown text="![gone](./missing.png)" resolve={() => null} loadImage={vi.fn()} />);
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it('shows a placeholder when the read fails', async () => {
    const loadImage = vi.fn().mockRejectedValue(new Error('permission denied'));
    render(
      <Markdown
        text="![diagram](./arch.png)"
        resolve={() => ({ path: '/ws/arch.png', kind: 'image' })}
        loadImage={loadImage}
      />,
    );
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it('revokes its object URL on unmount', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { unmount } = render(
      <Markdown
        text="![diagram](./arch.png)"
        resolve={() => ({ path: '/ws/arch.png', kind: 'image' })}
        loadImage={vi.fn().mockResolvedValue(PNG_BYTES)}
      />,
    );
    await screen.findByAltText('diagram');
    unmount();
    expect(revoke).toHaveBeenCalled();
  });

  it('clears the stale image while a new path is loading rather than showing the revoked blob', async () => {
    let resolveB: (bytes: Uint8Array) => void = () => {};
    const loadImage = vi.fn((path: string) => {
      if (path === '/ws/a.png') return Promise.resolve(PNG_BYTES);
      return new Promise<Uint8Array>(resolve => { resolveB = resolve; });
    });
    // A single stable resolve reference across both renders: passing a fresh
    // arrow function per render would change Markdown's `components` useMemo
    // identity (resolve is one of its deps), forcing react-markdown to treat
    // the img override as a new element type and remount MarkdownImage from
    // scratch — which would reset its state and hide the exact stale-url bug
    // this test exists to catch.
    const resolve = (target: string) => (
      target === './a.png' ? { path: '/ws/a.png', kind: 'image' as const } : { path: '/ws/b.png', kind: 'image' as const }
    );
    const { rerender } = render(<Markdown text="![a](./a.png)" resolve={resolve} loadImage={loadImage} />);
    const imgA = await screen.findByAltText('a');
    expect(imgA.getAttribute('src')).toMatch(/^blob:/);

    rerender(<Markdown text="![b](./b.png)" resolve={resolve} loadImage={loadImage} />);

    // While B is still loading, the old blob for A must not remain on
    // screen — it has already been revoked by the cleanup for A's effect.
    await waitFor(() => expect(screen.getByText(/loading/i)).toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    resolveB(PNG_BYTES);
    const imgB = await screen.findByAltText('b');
    expect(imgB.getAttribute('src')).toMatch(/^blob:/);
  });

  it('falls back to the placeholder when the bytes arrive but will not decode', async () => {
    // A file named .png that isn't one, or a format this webview won't
    // render: the read succeeds and the <img> then fails. With no onError
    // the user gets the browser's broken-image glyph instead of the
    // placeholder every other failure on this path already renders.
    render(
      <Markdown
        text="![diagram](./arch.png)"
        resolve={() => ({ path: '/ws/arch.png', kind: 'image' })}
        loadImage={vi.fn().mockResolvedValue(PNG_BYTES)}
      />,
    );
    fireEvent.error(await screen.findByAltText('diagram'));
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('types the object URL blob as image/svg+xml for an .svg path, not a generic type', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const loadImage = vi.fn().mockResolvedValue(PNG_BYTES);
    render(
      <Markdown
        text="![icon](./icon.svg)"
        resolve={() => ({ path: '/ws/icon.svg', kind: 'image' })}
        loadImage={loadImage}
      />,
    );
    await screen.findByAltText('icon');
    expect(createObjectURL).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/svg+xml');
  });
});
