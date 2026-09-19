// apps/desktop/src/markdown/resolve.test.ts
import { describe, expect, it } from 'vitest';
import { isExternal, resolveInArtifacts, resolveInWorkspace } from './resolve.ts';

describe('isExternal', () => {
  it('recognises the schemes we hand to the browser', () => {
    expect(isExternal('https://example.com')).toBe(true);
    expect(isExternal('http://example.com')).toBe(true);
    expect(isExternal('mailto:a@b.c')).toBe(true);
  });

  it('does not treat a Windows-absolute path as a URL with a one-letter scheme', () => {
    // `C:/docs/plan.md` used to parse as scheme `c` and go to the browser.
    expect(isExternal('C:/docs/plan.md')).toBe(false);
    expect(isExternal('c:\\docs\\plan.md')).toBe(false);
    expect(isExternal('D:/img/a.png')).toBe(false);
    // A drive-relative `C:foo` is not something we emit and stays a scheme; longer schemes always do.
    expect(isExternal('C:foo')).toBe(true);
    expect(isExternal('file:///C:/x')).toBe(true);
    expect(isExternal('ab:/x')).toBe(true);
  });

  it('does not treat a relative path or fragment as external', () => {
    expect(isExternal('./review.md')).toBe(false);
    expect(isExternal('docs/plan.md')).toBe(false);
    expect(isExternal('#section')).toBe(false);
  });
});

describe('resolveInWorkspace', () => {
  const root = '/ws';

  it('resolves a sibling path', () => {
    expect(resolveInWorkspace('/ws/docs', root, './review.md'))
      .toEqual({ path: '/ws/docs/review.md', kind: 'link' });
  });

  it('resolves a parent path and normalizes the .. away', () => {
    // TauriFileSystem rejects any path containing '..', so resolution must
    // produce a clean path, not one the port will refuse.
    expect(resolveInWorkspace('/ws/docs', root, '../src/auth.ts'))
      .toEqual({ path: '/ws/src/auth.ts', kind: 'link' });
  });

  it('refuses a path that escapes the workspace root', () => {
    expect(resolveInWorkspace('/ws/docs', root, '../../etc/passwd')).toBeNull();
  });

  it('treats a root-relative target as relative to the workspace, not the disk', () => {
    expect(resolveInWorkspace('/ws/docs', root, '/src/auth.ts'))
      .toEqual({ path: '/ws/src/auth.ts', kind: 'link' });
  });

  it('drops a query string and fragment before resolving', () => {
    expect(resolveInWorkspace('/ws', root, './plan.md#approach'))
      .toEqual({ path: '/ws/plan.md', kind: 'link' });
  });

  it('decodes percent-escapes so a spaced filename resolves', () => {
    expect(resolveInWorkspace('/ws', root, './my%20plan.md'))
      .toEqual({ path: '/ws/my plan.md', kind: 'link' });
  });

  it('returns null for an in-page fragment, which is not a file at all', () => {
    expect(resolveInWorkspace('/ws', root, '#approach')).toBeNull();
  });

  it('marks a known image extension as an image', () => {
    expect(resolveInWorkspace('/ws', root, './arch.png')?.kind).toBe('image');
  });

  it('classifies images by the Files preview rule: a dotfile or bare name has no extension', () => {
    // `.png` is a dotfile and `png` a file with no extension — neither is an
    // image to the preview (isImagePath), so neither may be one here.
    expect(resolveInWorkspace('/ws', root, './.png')?.kind).toBe('link');
    expect(resolveInWorkspace('/ws', root, './png')?.kind).toBe('link');
    expect(resolveInWorkspace('/ws', root, './ARCH.PNG')?.kind).toBe('image');
  });

  it('works with Windows separators', () => {
    expect(resolveInWorkspace('C:\\ws\\docs', 'C:\\ws', '../plan.md'))
      .toEqual({ path: 'C:\\ws\\plan.md', kind: 'link' });
  });

  it('routes a Windows-absolute target to the file port, through the same containment check', () => {
    expect(resolveInWorkspace('C:\\Proj\\docs', 'C:\\Proj', 'C:/Proj/docs/plan.md'))
      .toEqual({ path: 'C:\\Proj\\docs\\plan.md', kind: 'link' });
    expect(resolveInWorkspace('C:\\Proj\\docs', 'C:\\Proj', 'C:\\Proj\\img\\a.png'))
      .toEqual({ path: 'C:\\Proj\\img\\a.png', kind: 'image' });
    // Outside the workspace, another drive, and a sibling that merely shares the prefix are all refused.
    expect(resolveInWorkspace('C:\\Proj\\docs', 'C:\\Proj', 'C:/Windows/win.ini')).toBeNull();
    expect(resolveInWorkspace('C:\\Proj\\docs', 'C:\\Proj', 'D:/Proj/plan.md')).toBeNull();
    expect(resolveInWorkspace('C:\\Proj\\docs', 'C:\\Proj', 'C:/Project/plan.md')).toBeNull();
    expect(resolveInWorkspace('C:\\Proj\\docs', 'C:\\Proj', 'C:/Proj/../Other/x.md')).toBeNull();
  });

  it('compares case-blind on Windows: C:\\Proj and c:\\proj are the same workspace', () => {
    expect(resolveInWorkspace('C:\\Proj\\docs', 'C:\\Proj', 'c:/proj/docs/plan.md')?.kind).toBe('link');
  });

  it('refuses a Windows-absolute target when the workspace is POSIX', () => {
    expect(resolveInWorkspace('/ws/docs', '/ws', 'C:/x/y.md')).toBeNull();
  });

  it('refuses a sibling directory whose name starts with the root', () => {
    expect(resolveInWorkspace('/ws/docs', '/ws', '../../ws-evil/x')).toBeNull();
  });

  it('refuses traversal that arrives percent-encoded', () => {
    expect(resolveInWorkspace('/ws/docs', '/ws', '..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveInWorkspace('/ws/docs', '/ws', '%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });
});

describe('resolveInArtifacts', () => {
  const artifacts = [{ name: 'review.md', path: '/runs/r1/review.md' }];

  it('resolves a target that names an artifact of this run', () => {
    expect(resolveInArtifacts(artifacts, './review.md'))
      .toEqual({ path: '/runs/r1/review.md', kind: 'link' });
  });

  it('matches on the bare name too', () => {
    expect(resolveInArtifacts(artifacts, 'review.md')?.path).toBe('/runs/r1/review.md');
  });

  it('refuses anything that is not an artifact of this run', () => {
    expect(resolveInArtifacts(artifacts, '../../../etc/passwd')).toBeNull();
    expect(resolveInArtifacts(artifacts, './plan.md')).toBeNull();
  });
});
