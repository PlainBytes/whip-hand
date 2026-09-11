#!/usr/bin/env node
/**
 * Extracts the `whiphand` CLI's declared surface (commands, arguments, options)
 * straight from `buildProgram()` — the single source of truth for what the
 * CLI accepts. Consumed by surface.test.ts to catch CLI↔UI drift, and
 * runnable standalone to print the surface as canonical JSON.
 */
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { buildProgram } from '../packages/cli/src/program.ts';

export interface CliArgSurface {
  name: string;
  required: boolean;
}

export interface CliOptionSurface {
  /** Raw flags string as declared, e.g. "--dry-run" or "-C <dir>". */
  flags: string;
  short?: string;
  long?: string;
  /** Whether a value must be supplied when the option is specified. */
  required: boolean;
  hasDefault: boolean;
}

export interface CliCommandSurface {
  name: string;
  args: CliArgSurface[];
  options: CliOptionSurface[];
}

export interface CliSurface {
  commands: CliCommandSurface[];
}

/**
 * Implicit help/version flags commander adds on its own — not something we
 * declared, so parity has nothing to say about them. In practice these never
 * show up in `command.options` (help is lazily attached and version is only
 * registered on the root `program`, not on individual subcommands), but the
 * filter stays as a defensive guard against that changing.
 */
function isImplicitOption(long: string | undefined, short: string | undefined): boolean {
  return long === '--help' || long === '--version' || short === '-h' || short === '-V';
}

/**
 * Recurses into subcommands (e.g. `whiphand config get`), naming each by its full
 * space-joined path so parity can address it distinctly from its siblings.
 * A pure grouping command — one with subcommands of its own and no args or
 * options — contributes only its children: nothing ever actually invokes
 * `whiphand config` by itself, so it needs no uiActions entry of its own.
 */
function walk(cmd: Command, prefix: string[]): CliCommandSurface[] {
  const path = [...prefix, cmd.name()];
  const args = cmd.registeredArguments.map(arg => ({ name: arg.name(), required: arg.required }));
  const options = cmd.options
    .filter(opt => !isImplicitOption(opt.long, opt.short))
    .map(opt => ({
      flags: opt.flags,
      short: opt.short,
      long: opt.long,
      required: opt.required,
      hasDefault: opt.defaultValue !== undefined,
    }));
  const children = cmd.commands.flatMap(child => walk(child, path));
  const isPureGroup = children.length > 0 && args.length === 0 && options.length === 0;
  return isPureGroup ? children : [{ name: path.join(' '), args, options }, ...children];
}

export function extractCliSurface(): CliSurface {
  const program = buildProgram();
  return { commands: program.commands.flatMap(cmd => walk(cmd, [])) };
}

/** Recursively sorts object keys (arrays keep their order) for a canonical JSON rendering. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  console.log(JSON.stringify(sortKeysDeep(extractCliSurface()), null, 2));
}
