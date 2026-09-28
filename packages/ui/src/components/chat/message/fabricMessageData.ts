/**
 * smarty-code#739: an agent-to-agent Fabric message delivered into a session (a steer or follow-up that started a
 * turn). Only the gateway's projection owns `metadata.smartyFabric` (sender from the Fabric envelope); the message
 * text is never evidence of a sender, so a plain user message is never shown as one.
 */
/** `text`: the message body without the delivery prefix, when the gateway sends it. */
export type FabricMessage = { from: string; to?: string; ref?: string; text?: string };

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export const fabricMessageOf = (info: unknown): FabricMessage | undefined => {
    const meta = (info as { metadata?: { smartyFabric?: { from?: unknown; to?: unknown; ref?: unknown; text?: unknown } } } | undefined)
        ?.metadata?.smartyFabric;
    const from = str(meta?.from);
    if (!from) return undefined;
    return { from, to: str(meta?.to), ref: str(meta?.ref), text: str(meta?.text) };
};
