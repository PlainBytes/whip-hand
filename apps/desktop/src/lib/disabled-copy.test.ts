import { describe, expect, it } from 'vitest';
import { readerNotes } from './disabled-copy.ts';
import type { AgentStep, Workflow } from '../shared/types.ts';

const agent = (over: Partial<AgentStep> & { id: string }): AgentStep => ({
  kind: 'agent', runner: 'claude', mode: 'headless', writes: false,
  prompt: `p`, output: `${over.id}.md`, ...over,
});

describe('readerNotes', () => {
  it('one note per reader, naming the disabled step it lost', () => {
    const wf: Workflow = {
      name: 'w',
      steps: [
        agent({ id: 'plan', enabled: false }),
        agent({ id: 'execute', inputs: ['plan'] }),
        agent({ id: 'commit-message', inputs: ['plan'] }),
      ],
    };
    const notes = readerNotes(wf);
    expect(notes).toEqual([
      { stepId: 'execute', text: 'Reads plan, which is disabled — this step will run without it.' },
      { stepId: 'commit-message', text: 'Reads plan, which is disabled — this step will run without it.' },
    ]);
  });

  it('a reader that lost two inputs gets one note, not two', () => {
    const wf: Workflow = {
      name: 'w',
      steps: [
        agent({ id: 'plan', enabled: false }),
        agent({ id: 'review', enabled: false, inputs: ['plan'] }),
        agent({ id: 'commit-message', inputs: ['plan', 'review'] }),
      ],
    };
    const notes = readerNotes(wf);
    // 'review' itself is disabled, so its own dropped 'plan' reference is not
    // worth a note — only an enabled reader's card gets one.
    expect(notes).toEqual([
      { stepId: 'commit-message', text: 'Reads plan and review, which are disabled — this step will run without them.' },
    ]);
  });

  it('no notes when nothing is disabled', () => {
    const wf: Workflow = { name: 'w', steps: [agent({ id: 'a' }), agent({ id: 'b', inputs: ['a'] })] };
    expect(readerNotes(wf)).toEqual([]);
  });
});
