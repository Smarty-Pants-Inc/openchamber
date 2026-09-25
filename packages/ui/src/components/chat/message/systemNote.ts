/**
 * A native session note the gateway marks `clientRole: 'system-note'` (smarty-voice call started, renewed or ended).
 * It is neither the person's nor the agent's message.
 */
export const isSystemNoteMessage = (info: unknown): boolean =>
    (info as { clientRole?: unknown } | null | undefined)?.clientRole === 'system-note';
