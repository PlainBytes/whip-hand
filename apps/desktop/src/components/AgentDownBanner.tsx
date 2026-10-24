import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useAppStore } from '../state/store.ts';
import { DismissibleWarning } from './DismissibleWarning.tsx';

const AGENT_STATUS_MESSAGE: Record<string, string> = {
  connecting: 'Connecting to the whiphand agent…',
  reconnecting: 'The whiphand agent disconnected — reconnecting…',
  down: 'The whiphand agent is unavailable. Restart Whiphand to retry.',
};

export function AgentDownBanner() {
  const agentStatus = useAppStore(state => state.agentStatus);
  if (agentStatus === 'connected') return null;

  const content = (
    <>
      <MessageBarTitle>Agent {agentStatus}</MessageBarTitle>
      {AGENT_STATUS_MESSAGE[agentStatus]}
    </>
  );

  // "Down" stays put: nothing works until a restart, so hiding it would only
  // hide the reason. The transient states are warnings like any other.
  if (agentStatus === 'down') {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{content}</MessageBarBody>
      </MessageBar>
    );
  }
  return <DismissibleWarning dismissKey={`agent:${agentStatus}`}>{content}</DismissibleWarning>;
}
