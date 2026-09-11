import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useAppStore } from '../state/store.ts';

const AGENT_STATUS_MESSAGE: Record<string, string> = {
  connecting: 'Connecting to the whiphand agent…',
  reconnecting: 'The whiphand agent disconnected — reconnecting…',
  down: 'The whiphand agent is unavailable. Restart Whiphand to retry.',
};

export function AgentDownBanner() {
  const agentStatus = useAppStore(state => state.agentStatus);
  if (agentStatus === 'connected') return null;

  return (
    <MessageBar intent={agentStatus === 'down' ? 'error' : 'warning'}>
      <MessageBarBody>
        <MessageBarTitle>Agent {agentStatus}</MessageBarTitle>
        {AGENT_STATUS_MESSAGE[agentStatus]}
      </MessageBarBody>
    </MessageBar>
  );
}
