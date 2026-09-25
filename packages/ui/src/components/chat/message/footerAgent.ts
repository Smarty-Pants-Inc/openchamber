/**
 * The agent label under an assistant reply (smarty-code#126 F7 (b)). The default 'build' agent says nothing a
 * reader needs, and the Smarty Code gateway stamps 'build' on every ordinary Pi message, so it is hidden.
 * ponytail: a name rule, not a per-message session lookup, keeps the message render path free of another store
 * subscription. Revisit if an ordinary session can report a non-default agent.
 */
const DEFAULT_AGENT_NAME = 'build';

export const visibleFooterAgentName = (agentName: string | undefined): string | undefined => (
  agentName && agentName.trim().toLowerCase() !== DEFAULT_AGENT_NAME ? agentName : undefined
);
