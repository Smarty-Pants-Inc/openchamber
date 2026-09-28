import type { Message } from '@opencode-ai/sdk/v2';

/**
 * A native session note the gateway marks `clientRole: 'system-note'` (smarty-voice call started, renewed or ended).
 * It is neither the person's nor the agent's message.
 */
export const isSystemNoteMessage = (info: Message | null | undefined): boolean =>
    info != null && 'clientRole' in info && info.clientRole === 'system-note';
