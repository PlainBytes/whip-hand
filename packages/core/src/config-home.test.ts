import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { globalConfigPath, globalWorkflowsDir, resolveConfigHome } from './config-home.ts';

test('resolveConfigHome honors WHIPHAND_CONFIG_HOME override', () => {
  assert.equal(
    resolveConfigHome({ WHIPHAND_CONFIG_HOME: '/x/config-home' }, 'linux', '/home/u'),
    '/x/config-home',
  );
});

test('resolveConfigHome uses XDG_CONFIG_HOME on linux, ~/.config fallback', () => {
  assert.equal(
    resolveConfigHome({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/u'),
    join('/xdg', 'whiphand'),
  );
  assert.equal(
    resolveConfigHome({}, 'linux', '/home/u'),
    join('/home/u', '.config', 'whiphand'),
  );
});

test('resolveConfigHome picks platform dirs on darwin and win32', () => {
  assert.equal(
    resolveConfigHome({}, 'darwin', '/Users/u'),
    join('/Users/u', 'Library', 'Application Support', 'whiphand'),
  );
  assert.equal(
    resolveConfigHome({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'),
    join('C:\\Users\\u\\AppData\\Roaming', 'whiphand'),
  );
  // win32 without APPDATA set falls back the same way app-state.ts does.
  assert.equal(
    resolveConfigHome({}, 'win32', 'C:\\Users\\u'),
    join('C:\\Users\\u', 'AppData', 'Roaming', 'whiphand'),
  );
});

test('XDG_CONFIG_HOME is honored on linux only, not darwin', () => {
  assert.equal(
    resolveConfigHome({ XDG_CONFIG_HOME: '/xdg' }, 'darwin', '/Users/u'),
    join('/Users/u', 'Library', 'Application Support', 'whiphand'),
  );
});

test('globalWorkflowsDir and globalConfigPath sit under the resolved root', () => {
  const env = { WHIPHAND_CONFIG_HOME: '/x/config-home' };
  assert.equal(globalWorkflowsDir(env, 'linux', '/home/u'), join('/x/config-home', 'workflows'));
  assert.equal(globalConfigPath(env, 'linux', '/home/u'), join('/x/config-home', 'config.yaml'));
});
