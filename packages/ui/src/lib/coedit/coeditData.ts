/**
 * smartyfs#18 co-editing slice 1, the client's view of the server's rooms (openchamber feat/coedit-rooms,
 * packages/web/server/lib/coedit). The server owns the room name, the disk bridge and every save; the client shows
 * what happened.
 */

/** The server's Y.Text name for the file's text (disk-bridge.js TEXT). */
export const COEDIT_TEXT = 'content';
/** The server's stateless message when a save could not be published (rooms.js CONFLICT_MESSAGE). */
export const COEDIT_CONFLICT_MESSAGE = 'coedit-conflict';

export type CoeditConflictKind = 'changed' | 'gone' | 'truncated' | 'interrupted' | 'unverified' | 'raced' | 'escaped';
export type CoeditConflict = { kind: CoeditConflictKind; at: number; recovered: boolean };

const KINDS: readonly string[] = ['changed', 'gone', 'truncated', 'interrupted', 'unverified', 'raced', 'escaped'];

/** A `coedit-conflict` stateless payload, or null for any other message (never trusted beyond its known kinds). */
export const parseCoeditConflict = (payload: string): CoeditConflict | null => {
    let data: unknown;
    try { data = JSON.parse(payload); } catch { return null; }
    const message = data as { type?: unknown; conflict?: unknown; at?: unknown; recovered?: unknown } | null;
    if (!message || message.type !== COEDIT_CONFLICT_MESSAGE || typeof message.conflict !== 'string' || !KINDS.includes(message.conflict)) return null;
    return { kind: message.conflict as CoeditConflictKind, at: typeof message.at === 'number' ? message.at : Date.now(), recovered: message.recovered === true };
};

/** The i18n key of the editor notice for a conflict: the bridge's own wording (DOCUMENTATION.md). */
export const coeditConflictNoticeKey = (kind: CoeditConflictKind) => ({
    unverified: 'filesView.coedit.conflict.raced',
    raced: 'filesView.coedit.conflict.raced',
    escaped: 'filesView.coedit.conflict.raced',
    interrupted: 'filesView.coedit.conflict.interrupted',
    changed: 'filesView.coedit.conflict.changed',
    gone: 'filesView.coedit.conflict.gone',
    truncated: 'filesView.coedit.conflict.truncated',
} as const)[kind];

/** A stable, readable color per person (their cursor, selection and name tag). */
export const coeditColor = (seed: string): { color: string; colorLight: string } => {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    const hue = hash % 360;
    return { color: `hsl(${hue} 70% 42%)`, colorLight: `hsl(${hue} 70% 42% / 0.18)` };
};
