#!/usr/bin/env node
import { buildProgram } from './program.ts';

// Deliberately not top-level await: this file is bundled to CommonJS for the
// standalone binary (Node rejects an ESM main for a single executable
// application), and CommonJS has no top-level await. The catch replaces what
// the unhandled-rejection path did for free.
//
// `process.argv` needs no adjustment inside a single executable: Node supplies
// [execPath, argv0, ...args] there, the same two leading entries commander's
// default `from: 'node'` expects. Verified against a real SEA build.
buildProgram().parseAsync(process.argv)
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
