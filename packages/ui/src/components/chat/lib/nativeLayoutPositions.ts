import { z } from 'zod';
import type { ChatMessageEntry } from './turns/types';
import { optimisticMessageRecords } from '@/sync/unsaved';

const identity = z.string().min(1).max(256).regex(/^\S+$/);
const nativeUser = z.object({
    id: identity,
    sessionID: identity,
    role: z.literal('user'),
    metadata: z.object({
        pi: z.object({ entryID: identity }),
        smartyCodeEchoOf: identity.optional(),
        smartyVoice: z.object({ start: z.boolean().optional() }).optional(),
    }),
});
type NativeUser = z.infer<typeof nativeUser>;
export type NativeLayoutCoordinate = { user: NativeUser; at: number };
// Retain only a bounded identity/coordinate snapshot, never bodies or SDK records.
const MAX_NATIVE_COORDINATES = 2048;
const readNativeUser = (message: ChatMessageEntry) => {
    if (optimisticMessageRecords.has(message.info)) return undefined;
    const user = nativeUser.safeParse(message.info).data;
    return user?.metadata.smartyVoice?.start ? undefined : user;
};
const nativeKey = (user: NativeUser) => JSON.stringify([user.sessionID, user.metadata.pi.entryID]);

export function snapshotNativeLayout(
    messages: ChatMessageEntry[],
    positionOf: ((id: string) => number | undefined) | undefined,
): NativeLayoutCoordinate[] {
    const snapshot: NativeLayoutCoordinate[] = [];
    for (const message of messages) {
        const user = readNativeUser(message);
        if (!user || user.id !== user.metadata.pi.entryID) continue;
        const at = positionOf?.(user.id);
        if (at === undefined || !Number.isInteger(at) || at < 0) continue;
        snapshot.push({ user, at });
        if (snapshot.length === MAX_NATIVE_COORDINATES) break;
    }
    return snapshot;
}

/** Layout identity only. This neither confirms a Send nor grants loader coverage or body readiness. */
export function withNativeLayoutPositions(
    messages: ChatMessageEntry[],
    positionOf: ((id: string) => number | undefined) | undefined,
    snapshot: NativeLayoutCoordinate[],
): ((id: string) => number | undefined) | undefined {
    if (!positionOf) return undefined;
    const currentById = new Map<string, ChatMessageEntry[]>();
    const users = new Map<string, NativeUser>();
    const aliases = new Map<string, string | null>();
    const publicOwners = new Map<string, string | null>();
    const ownPublicId = (user: NativeUser) => {
        const key = nativeKey(user);
        if (publicOwners.has(user.id) && publicOwners.get(user.id) !== key) publicOwners.set(user.id, null);
        else publicOwners.set(user.id, key);
    };
    for (const message of messages) {
        const rows = currentById.get(message.info.id) ?? [];
        rows.push(message);
        currentById.set(message.info.id, rows);
        const user = readNativeUser(message);
        if (!user) continue;
        users.set(user.id, user);
        ownPublicId(user);
        if (user.id === user.metadata.pi.entryID) continue;
        const key = nativeKey(user);
        aliases.set(key, aliases.has(key) || user.metadata.smartyCodeEchoOf !== undefined ? null : user.id);
    }
    const rawByEntry = new Map<string, NativeLayoutCoordinate | null>();
    for (const coordinate of snapshot) {
        const { user } = coordinate;
        const current = currentById.get(user.id);
        // A live record always wins over a retired identity, including malformed/foreign replacements.
        if (current && (current.length !== 1 || nativeKey(users.get(user.id) ?? user) !== nativeKey(user)
            || !users.has(user.id))) continue;
        const raw = current ? users.get(user.id)! : user;
        if (raw.id !== raw.metadata.pi.entryID) continue;
        ownPublicId(raw);
        const key = nativeKey(raw);
        rawByEntry.set(key, rawByEntry.has(key) ? null : { user: raw, at: coordinate.at });
    }
    // Current raw rows may have coordinates even before the next coherent snapshot is committed.
    for (const user of users.values()) {
        if (user.id !== user.metadata.pi.entryID) continue;
        const at = positionOf(user.id);
        if (at !== undefined && currentById.get(user.id)?.length === 1) {
            rawByEntry.set(nativeKey(user), { user, at });
        }
    }
    const fallback = new Map<string, number>();
    for (const [key, alias] of aliases) {
        if (!alias || currentById.get(alias)?.length !== 1 || publicOwners.get(alias) !== key) continue;
        const raw = rawByEntry.get(key);
        if (!raw || publicOwners.get(raw.user.id) !== key) continue;
        const echo = raw.user.metadata.smartyCodeEchoOf;
        if (echo !== undefined && echo !== alias) continue;
        fallback.set(alias, positionOf(raw.user.id) ?? raw.at);
    }
    // Reflected public IDs remain primary; a native link only fills a missing layout coordinate.
    return (id) => positionOf(id) ?? fallback.get(id);
}
