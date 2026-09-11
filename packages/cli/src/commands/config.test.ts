import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configGetCommand, configSetCommand, projectConfigPath } from './config.ts';

async function withConfigHome<T>(fn: (configHome: string) => Promise<T>): Promise<T> {
  const configHome = await mkdtemp(join(tmpdir(), 'whiphand-config-home-'));
  const prev = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = configHome;
  try {
    return await fn(configHome);
  } finally {
    if (prev === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
    else process.env.WHIPHAND_CONFIG_HOME = prev;
  }
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => { console.log = origLog; process.stdout.write = origWrite; },
  };
}

test('config get with no key prints the whole resolved config as YAML', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      const code = await configGetCommand(undefined, { global: false, cwd });
      assert.equal(code, 0);
    } finally {
      out.restore();
    }
    const parsed = parseYaml(out.lines.join(''));
    assert.equal(parsed.defaults.runner, 'claude');
  });
});

test('config get <key> prints just that value', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      const code = await configGetCommand('loop.max_iterations', { global: false, cwd });
      assert.equal(code, 0);
    } finally {
      out.restore();
    }
    assert.equal(out.lines.join('').trim(), '3');
  });
});

test('config get rejects an unknown key with exit code 2', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      const code = await configGetCommand('nope.field', { global: false, cwd });
      assert.equal(code, 2);
    } finally {
      out.restore();
    }
  });
});

test('config set writes into the project layer, and a following get reflects it', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      assert.equal(await configSetCommand('loop.max_iterations', '7', { global: false, cwd }), 0);
    } finally {
      out.restore();
    }
    const onDisk = parseYaml(await readFile(projectConfigPath(cwd), 'utf8'));
    assert.deepEqual(onDisk, { loop: { max_iterations: 7 } });

    const out2 = captureStdout();
    try {
      await configGetCommand('loop.max_iterations', { global: false, cwd });
    } finally {
      out2.restore();
    }
    assert.equal(out2.lines.join('').trim(), '7');
  });
});

test('config set --global writes into the global layer, visible from any workspace', async () => {
  await withConfigHome(async configHome => {
    const out = captureStdout();
    try {
      assert.equal(
        await configSetCommand('defaults.runner', 'copilot', { global: true, cwd: '/unused' }), 0);
    } finally {
      out.restore();
    }
    const onDisk = parseYaml(await readFile(join(configHome, 'config.yaml'), 'utf8'));
    assert.deepEqual(onDisk, { defaults: { runner: 'copilot' } });

    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out2 = captureStdout();
    try {
      await configGetCommand('defaults.runner', { global: false, cwd });
    } finally {
      out2.restore();
    }
    assert.equal(out2.lines.join('').trim(), 'copilot');
  });
});

test('config set only writes what differs from the layer beneath', async () => {
  await withConfigHome(async configHome => {
    await mkdir(configHome, { recursive: true });
    await writeFile(join(configHome, 'config.yaml'), 'defaults: { runner: copilot }\n');
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      // Setting the project layer to the same value the global layer already
      // supplies must not pin it into the project file.
      assert.equal(await configSetCommand('defaults.runner', 'copilot', { global: false, cwd }), 0);
    } finally {
      out.restore();
    }
    const onDisk = parseYaml(await readFile(projectConfigPath(cwd), 'utf8'));
    assert.deepEqual(onDisk, {});
  });
});

test('config set runs.max_retained null keeps every run, distinct from a numeric cap', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      assert.equal(await configSetCommand('runs.max_retained', '5', { global: false, cwd }), 0);
    } finally {
      out.restore();
    }
    assert.deepEqual(parseYaml(await readFile(projectConfigPath(cwd), 'utf8')), { runs: { max_retained: 5 } });

    const out2 = captureStdout();
    try {
      assert.equal(await configSetCommand('runs.max_retained', 'null', { global: false, cwd }), 0);
    } finally {
      out2.restore();
    }
    // null is what DEFAULT_CONFIG already means for this leaf, so setting it
    // back to null is indistinguishable from clearing the override entirely
    // — the layer collapses to {}, not an explicit `max_retained: null`.
    assert.deepEqual(parseYaml(await readFile(projectConfigPath(cwd), 'utf8')), {});

    const out3 = captureStdout();
    try {
      await configGetCommand('runs.max_retained', { global: false, cwd });
    } finally {
      out3.restore();
    }
    assert.equal(out3.lines.join('').trim(), 'null');
  });
});

test('config set runs.max_retained null against a global cap records an explicit override, not an empty layer', async () => {
  await withConfigHome(async configHome => {
    await mkdir(configHome, { recursive: true });
    await writeFile(join(configHome, 'config.yaml'), 'runs: { max_retained: 10 }\n');
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      assert.equal(await configSetCommand('runs.max_retained', 'null', { global: false, cwd }), 0);
    } finally {
      out.restore();
    }
    assert.deepEqual(
      parseYaml(await readFile(projectConfigPath(cwd), 'utf8')), { runs: { max_retained: null } });
  });
});

test('config set rejects an invalid value with exit code 2 and writes nothing', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      assert.equal(await configSetCommand('loop.max_iterations', 'not-a-number', { global: false, cwd }), 2);
      assert.equal(await configSetCommand('on_findings', 'nonsense', { global: false, cwd }), 2);
    } finally {
      out.restore();
    }
    await assert.rejects(() => readFile(projectConfigPath(cwd), 'utf8'));
  });
});

test('config set rejects runs.max_retained 0 — not a meaningful cap now that null means "keep everything"', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    try {
      assert.equal(await configSetCommand('runs.max_retained', '0', { global: false, cwd }), 2);
    } finally {
      out.restore();
    }
    await assert.rejects(() => readFile(projectConfigPath(cwd), 'utf8'));
  });
});

test('config set runs.max_attachment_mb takes a positive number of megabytes, fractions included', async () => {
  await withConfigHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'whiphand-cli-config-'));
    const out = captureStdout();
    const origErr = console.error;
    console.error = () => {};
    try {
      assert.equal(await configSetCommand('runs.max_attachment_mb', '0', { global: false, cwd }), 2);
      assert.equal(await configSetCommand('runs.max_attachment_mb', 'lots', { global: false, cwd }), 2);
      assert.equal(await configSetCommand('runs.max_attachment_mb', '0.5', { global: false, cwd }), 0);
    } finally {
      out.restore();
      console.error = origErr;
    }
    const layer = parseYaml(await readFile(projectConfigPath(cwd), 'utf8'));
    assert.deepEqual(layer, { runs: { max_attachment_mb: 0.5 } });
  });
});
