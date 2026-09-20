import {
  detectTools, loadDoctorConfig, TOOL_GROUPS, TOOL_GROUP_LABELS,
  type AdapterRegistry, type ToolStatus,
} from '@whiphand/core';

/**
 * Renders exactly what the `doctor` RPC returns, so `whiphand doctor` and the
 * desktop's Doctor page cannot report different facts about the same machine.
 * The line grammar is a contract: the parity suite parses this output and
 * compares it against the RPC.
 */
export function doctorReport(statuses: readonly ToolStatus[]): string {
  const sections: string[] = [];

  for (const group of TOOL_GROUPS) {
    const rows = statuses.filter(status => status.group === group);
    if (rows.length === 0) continue;

    const lines = [TOOL_GROUP_LABELS[group]];
    for (const status of rows) {
      // Three marks, not two. A tool that is merely optional and absent is
      // not a fault, and printing it as ✘ beside a genuinely missing git
      // tells the user their machine is broken when it isn't.
      const mark = status.installed ? '✔' : status.optional ? '○' : '✘';
      const rest = status.installed ? (status.version ?? '(version unknown)') : 'not installed';
      lines.push(`${mark} ${status.id} ${rest}`);
      for (const note of status.notes ?? []) lines.push(`  · ${note}`);
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * The command itself: probe this machine — and, given a working folder, what is
 * wrong with that folder — then render it. The agent's `doctor` RPC takes the
 * same optional `workdir`, so the two still report the same facts.
 */
export async function runDoctor(registry: AdapterRegistry, workdir?: string): Promise<string> {
  return doctorReport(await detectTools(registry, await loadDoctorConfig(), workdir === undefined ? {} : { workdir }));
}
