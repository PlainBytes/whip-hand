/**
 * Resident set size of one process, in bytes, or null if it can't be read.
 * Linux reads /proc; Windows asks PowerShell (through exec.ts, like every
 * other spawn under scripts/); anything else is reported as unavailable
 * rather than guessed.
 */
import fs from 'node:fs';
import { runSync } from '../lib/exec.mjs';

export function rssBytes(pid) {
  if (process.platform === 'linux') {
    try {
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return match ? Number(match[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    const { status, stdout } = runSync(
      ['powershell', '-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).WorkingSet64`],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const value = Number(stdout.trim());
    return status === 0 && Number.isFinite(value) ? value : null;
  }
  return null;
}
