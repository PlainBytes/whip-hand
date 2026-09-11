import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCliSurface, type CliCommandSurface } from './extract-cli-surface.ts';
import { uiActions } from '../apps/desktop/src/parity/ui-actions.ts';

const UI_ACTIONS_PATH = 'apps/desktop/src/parity/ui-actions.ts';

function optionKey(opt: { long?: string; short?: string }): string {
  const key = opt.long ?? opt.short;
  if (!key) throw new Error('option has neither a long nor a short flag');
  return key;
}

const surface = extractCliSurface();

test('every CLI command has a uiActions entry with a _command mapping', () => {
  for (const cmd of surface.commands) {
    const entry = uiActions[cmd.name];
    assert.ok(
      entry,
      `CLI command '${cmd.name}' has no entry in ${UI_ACTIONS_PATH}. ` +
      `Add uiActions.${cmd.name} = { _command: 'page:<id>', ... }.`,
    );
    assert.ok(
      typeof entry._command === 'string' && entry._command.length > 0,
      `CLI command '${cmd.name}' has a ${UI_ACTIONS_PATH} entry but no '_command' mapping. ` +
      `Add a '_command' key naming the UI surface that starts this command.`,
    );
  }
});

test('every CLI arg and option has a uiActions mapping or an exempt:<reason>', () => {
  for (const cmd of surface.commands) {
    const entry = uiActions[cmd.name] ?? {};

    for (const arg of cmd.args) {
      const key = `<${arg.name}>`;
      assert.ok(
        key in entry,
        `CLI command '${cmd.name}' gained argument '${key}' with no UI mapping. ` +
        `Add an entry to ${UI_ACTIONS_PATH} (or mark it 'exempt:<reason>').`,
      );
    }

    for (const opt of cmd.options) {
      const key = optionKey(opt);
      assert.ok(
        key in entry,
        `CLI command '${cmd.name}' gained option '${key}' with no UI mapping. ` +
        `Add an entry to ${UI_ACTIONS_PATH} (or mark it 'exempt:<reason>').`,
      );
    }
  }
});

test('every uiActions entry corresponds to a real command/arg/option (no dangling mappings)', () => {
  const byName = new Map<string, CliCommandSurface>(surface.commands.map(c => [c.name, c]));

  for (const [cmdName, entry] of Object.entries(uiActions)) {
    const cmd = byName.get(cmdName);
    assert.ok(
      cmd,
      `${UI_ACTIONS_PATH} maps command '${cmdName}', but the CLI surface has no such command. ` +
      `Remove uiActions.${cmdName} or fix the CLI.`,
    );
    if (!cmd) continue;

    const realKeys = new Set<string>([
      ...cmd.args.map(a => `<${a.name}>`),
      ...cmd.options.map(optionKey),
    ]);

    for (const key of Object.keys(entry)) {
      if (key === '_command') continue;
      assert.ok(
        realKeys.has(key),
        `${UI_ACTIONS_PATH} maps '${key}' under command '${cmdName}', but the CLI surface has no ` +
        `such argument or option there. Remove it from ${UI_ACTIONS_PATH} or fix the CLI.`,
      );
    }
  }
});
