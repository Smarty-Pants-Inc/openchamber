import type { Message } from '@opencode-ai/sdk/v2';

/**
 * A native session note the gateway marks `clientRole: 'system-note'` (smarty-voice call started, renewed or ended).
 * It is neither the person's nor the agent's message.
 */
export const isSystemNoteMessage = (info: Message | { clientRole?: string } | null | undefined): boolean =>
    info != null && 'clientRole' in info && info.clientRole === 'system-note';

/**
 * The session's last message that is not a system note: what "the last message" means for a reply, a recap or an
 * error (a voice call note is neither the person's nor the agent's; smarty-code#360, openchamber#224 review).
 */
export function lastRealMessage<T extends Message>(messages: readonly T[] | null | undefined): T | null {
    for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
        const message = messages![index]!;
        if (!isSystemNoteMessage(message)) return message;
    }
    return null;
}
