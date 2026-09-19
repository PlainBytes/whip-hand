/**
 * Shared test code: the harness that makes the *same* tests run on Linux and
 * Windows, instead of a `skip` that quietly deletes them there.
 *
 * Of the 23 tests the Windows leg used to skip, 19 were one bug repeated across
 * five files — stub binaries written as `#!/usr/bin/env bash` with `chmodSync(0o755)`
 * on extensionless names, `:`-joined PATHs, POSIX path literals in `deepEqual`.
 * The fix is here, once: a stub is minted in the shape the platform actually
 * launches, PATH is joined with `path.delimiter`, and path literals go through
 * one helper.
 */
export { withStubBin, withUnreadableStubBin, mintVersionStubs, pathWith, withEnv } from './stubs.ts';
export type { StubBin } from './stubs.ts';
export { posix, fromPosix } from './paths.ts';
export { captureBundle, NORMALIZATION } from './bundle.ts';
export type { BundleFile, CaptureOptions } from './bundle.ts';
