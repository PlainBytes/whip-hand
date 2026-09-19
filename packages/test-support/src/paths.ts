import path from 'node:path';

/** A native path as `/`-separated, for `deepEqual` against a literal that must read the same on every platform. */
export function posix(p: string): string {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/** The inverse, for building an expected native path from a `/` literal. */
export function fromPosix(p: string): string {
  return p.split('/').join(path.sep);
}
