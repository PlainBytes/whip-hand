/**
 * The user's own doctor probes: `<configHome>/whiphand/doctor.yaml`.
 *
 * A SEPARATE file from config.yaml, deliberately, and the reason is not
 * tidiness. config.yaml is machine-owned: `configSet` (both scopes),
 * `whiphand config set` and the retention migration each rewrite it wholesale from
 * a freshly-built PartialConfig, so any key they don't know about is
 * destroyed with no error. (They already discard the file's comments, which
 * is the tell.) A hand-written tool table living there would survive until
 * the first time someone saved the Preferences page.
 *
 * Nothing writes this file, so it stays exactly as the user typed it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveConfigHome } from './config-home.ts';
import { loadYamlLayer } from './config.ts';
import { WorkflowError } from './schema.ts';
import type { DoctorToolsConfig, ToolProbe } from './tools.ts';

export function globalDoctorConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(resolveConfigHome(env, platform, home), 'doctor.yaml');
}

/**
 * `strictObject`, unlike every schema in config.ts — a deliberate departure.
 * Those are permissive because layers are round-tripped through writers that
 * depend on unknown keys being stripped. Nothing writes this file, so nothing
 * needs that, and silently ignoring a misspelled `argvs:` in a hand-written
 * table is a worse experience than saying so.
 *
 * `id` forbids whitespace because it is a column in the CLI's report, which
 * the parity suite parses with `\S+`; an id with a space would split a row in
 * two and desync the two surfaces.
 *
 * Keys are snake_case to match the rest of our YAML (`on_findings`,
 * `max_iterations`, `artifacts_dir`), and mapped to the camelCase ToolProbe
 * below.
 */
const doctorToolSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a bare name (no whitespace or slashes)'),
  label: z.string().min(1),
  group: z.enum(['harness', 'support']),
  argv: z.array(z.string().min(1)).min(1),
  aliases: z.array(z.string().min(1)).optional(),
  version_pattern: z.string().min(1).optional(),
  optional: z.boolean().optional(),
  url: z.string().url().optional(),
});

export const doctorConfigSchema = z.strictObject({
  tools: z.array(doctorToolSchema).optional(),
  hide: z.array(z.string().min(1)).optional(),
});

type DoctorToolLayer = z.infer<typeof doctorToolSchema>;

function toProbe(tool: DoctorToolLayer): ToolProbe {
  const { version_pattern: versionPattern, ...rest } = tool;
  return versionPattern === undefined ? rest : { ...rest, versionPattern };
}

/**
 * Compiled here rather than at probe time so an unusable pattern is a named
 * config error pointing at the file, not a throw from inside a version parse
 * that the caller reads as "this tool isn't installed".
 */
function assertPatternsCompile(tools: DoctorToolLayer[], path: string): void {
  const problems: string[] = [];
  for (const tool of tools) {
    if (tool.version_pattern === undefined) continue;
    try {
      new RegExp(tool.version_pattern);
    } catch (e) {
      problems.push(`${path}: tools.${tool.id}.version_pattern: ${(e as Error).message}`);
    }
  }
  if (problems.length > 0) throw new WorkflowError(problems);
}

/**
 * A missing file is an empty config — the overwhelmingly common case, and not
 * a condition worth reporting. Every failure past that names `path`, because
 * this one file affects every workspace on the machine and "group: invalid"
 * on its own gives no hint where to go and fix it.
 */
export async function loadDoctorConfig(
  path: string = globalDoctorConfigPath(),
): Promise<DoctorToolsConfig> {
  const data = await loadYamlLayer(path, doctorConfigSchema);
  if (data === undefined) return {};

  const tools = data.tools ?? [];
  assertPatternsCompile(tools, path);
  return {
    ...(data.tools === undefined ? {} : { tools: tools.map(toProbe) }),
    ...(data.hide === undefined ? {} : { hide: data.hide }),
  };
}
