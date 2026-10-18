#!/usr/bin/env node
/**
 * Smoke tests for the packaged CLI binary: whether it boots, carries the
 * engine and the embedded templates, and (on Windows) can contain a real run.
 * Run automatically at the end of cli.mjs. The desktop app has no binary of
 * its own to smoke: its agent runs inside it (crates/whiphand-agent), and
 * `parity/agent.test.ts` drives the same agent over stdio.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runSync } from '../lib/exec.mjs';
import { repoRoot, distDir } from './common.mjs';

/** The workflows `whiphand init` writes, compiled into the binary from here. */
const TEMPLATES_DIR = path.join(repoRoot, 'crates/whiphand-core/templates');

const exeSuffix = process.platform === 'win32' ? '.exe' : '';

function check(label, fn) {
  try {
    fn();
    process.stdout.write(`  ✔ ${label}\n`);
  } catch (error) {
    process.stdout.write(`  ✘ ${label}\n`);
    throw error;
  }
}

/**
 * Whether an ELF64 file names a program interpreter (PT_INTERP), i.e. needs
 * a dynamic loader, and so some distribution's libc, to start.
 */
export function hasInterpreter(bytes) {
  assert.equal(bytes.toString('latin1', 1, 4), 'ELF', 'not an ELF file');
  const phoff = Number(bytes.readBigUInt64LE(0x20));
  const phentsize = bytes.readUInt16LE(0x36);
  const phnum = bytes.readUInt16LE(0x38);
  for (let i = 0; i < phnum; i++) {
    if (bytes.readUInt32LE(phoff + i * phentsize) === 3) return true;
  }
  return false;
}

/** `static`: the Linux build is the musl one (cli.mjs without `--host`). */
export function smokeCli({ static: isStatic = true } = {}) {
  const whiphand = path.join(distDir, `whiphand${exeSuffix}`);
  process.stdout.write('smoke: whiphand\n');

  check('--version prints the core version', () => {
    const version = runSync([whiphand, '--version'], { stdio: ['ignore', 'pipe', 'inherit'], check: true }).stdout.trim();
    assert.match(version, /^\d+\.\d+\.\d+$/);
  });

  check('doctor reports on the runner CLIs', () => {
    // Exit code is 1 when a runner is missing, which is a valid outcome here;
    // the assertion is that it ran and reported rather than crashed.
    const { stdout } = runSync([whiphand, 'doctor'], { stdio: ['ignore', 'pipe', 'inherit'] });
    assert.match(stdout, /claude/);
  });

  check('run --dry-run resolves a workflow end to end', () => {
    // A temp workspace, so the smoke test never leaves a run directory behind
    // in the repo. `run` is also the token a broken argv path would eat.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-smoke-'));
    try {
      const workflow = path.join(workdir, 'smoke.yaml');
      fs.copyFileSync(path.join(repoRoot, 'scripts/package/fixtures/smoke.yaml'), workflow);
      const { stdout } = runSync([whiphand, 'run', workflow, '--dry-run', '--input', 'subject=packaging'], {
        stdio: ['ignore', 'pipe', 'inherit'], cwd: workdir, check: true,
      });
      assert.match(stdout, /step think/, 'the agent step was not resolved');
      assert.match(stdout, /Consider packaging/, 'inputs were not interpolated');
      assert.match(stdout, /step check/, 'the command step was not resolved');
      assert.match(stdout, /run complete/);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  check('init scaffolds the shipped workflows from the embedded templates', () => {
    // The templates are compiled into the binary, not files beside it: a
    // build that left one out fails here, not on a user's first `init`.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-smoke-init-'));
    try {
      runSync([whiphand, 'init'], { stdio: ['ignore', 'pipe', 'inherit'], cwd: workdir, check: true });
      const shipped = fs.readdirSync(TEMPLATES_DIR).filter(file => file.endsWith('.yaml'));
      assert.ok(shipped.length > 0, 'no templates to compare against');
      for (const file of shipped) {
        const written = fs.readFileSync(path.join(workdir, '.whiphand/workflows', file), 'utf8');
        assert.equal(written, fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'), `${file} is the template`);
      }
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  check('tui is a command', () => {
    const { stdout } = runSync([whiphand, 'tui', '--help'], { stdio: ['ignore', 'pipe', 'inherit'], check: true });
    assert.match(stdout, /terminal UI/);
  });

  check('bare whiphand off a terminal is the usage error, not the TUI', () => {
    const { status, stderr } = runSync([whiphand], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(status, 1);
    assert.match(stderr, /Usage: whiphand/);
  });

  check('desktop says where to get the app when it is missing', () => {
    const missing = path.join(os.tmpdir(), 'whiphand-smoke-no-desktop', `whiphand-desktop${exeSuffix}`);
    const { status, stderr } = runSync([whiphand, 'desktop'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WHIPHAND_DESKTOP: missing },
    });
    assert.equal(status, 1);
    assert.match(stderr, /not installed/);
  });

  // Linux only: the shipped binary is static, so it runs on any distribution
  // rather than only on the glibc of the runner that built it.
  if (process.platform === 'linux' && isStatic) {
    check('the binary is static (no program interpreter)', () => {
      assert.ok(!hasInterpreter(fs.readFileSync(whiphand)), 'needs a dynamic loader');
    });
  }

  // Windows only: the C runtime is linked in (.cargo/config.toml). A binary
  // importing it exits silently on a Windows without the VC++ redistributable,
  // and CI's runners have it, so nothing else would notice.
  if (process.platform === 'win32') {
    check('the binary does not import the VC++ runtime', () => {
      const bytes = fs.readFileSync(whiphand).toString('latin1').toLowerCase();
      assert.ok(!bytes.includes('vcruntime140'), 'imports VCRUNTIME140.dll');
    });
  }

  // Windows only: the packaged build must be able to contain a real run. Without
  // its Job Object (or a POSIX shell to run the command in) this exits 1.
  if (process.platform === 'win32') {
    check('a real command run starts under the process guard', () => {
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-smoke-run-'));
      try {
        const workflow = path.join(workdir, 'smoke-command.yaml');
        fs.copyFileSync(path.join(repoRoot, 'scripts/package/fixtures/smoke-command.yaml'), workflow);
        const { stdout } = runSync([whiphand, 'run', workflow], { stdio: ['ignore', 'pipe', 'inherit'], cwd: workdir, check: true });
        assert.match(stdout, /run complete/);
      } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    });
  }
}

if (import.meta.filename === process.argv[1]) {
  smokeCli();
}
