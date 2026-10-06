import type { MockTransport } from '../agent/transport.ts';
import type { ValidateWorkflowResult } from '../shared/protocol.gen.ts';
import type { Workflow } from '../shared/types.ts';

/** Stands in for the agent's validator: what validateWorkflow answers for a draft. */
export type Validator = (draft: Workflow) => ValidateWorkflowResult;

export const acceptAll: Validator = draft => ({ workflow: draft, problems: [], fieldProblems: [] });

/**
 * Answers every validateWorkflow request on `transport` from `validator`,
 * as the agent would. The validator itself is Rust's, tested there; these
 * tests check what the editor does with its answer.
 */
export function answerValidation(transport: MockTransport, validator: Validator = acceptAll): void {
  const send = transport.send.bind(transport);
  transport.send = (line: string) => {
    send(line);
    const request = JSON.parse(line) as { id: number; method: string; params: { draft: Workflow } };
    if (request.method !== 'validateWorkflow') return;
    queueMicrotask(() => transport.emitLine({ id: request.id, result: validator(request.params.draft) }));
  };
}
