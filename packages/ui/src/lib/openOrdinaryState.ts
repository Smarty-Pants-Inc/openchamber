import type { Session } from '@opencode-ai/sdk/v2';
import { readOrdinaryModel, type OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { getAllSyncSessions, getSyncSessions } from '@/sync/sync-refs';

/** The global store's mark on an open session one managed listing left out (smarty-code#600): kept, unavailable. */
export const isRetainedUnavailable = (session: Session | undefined): boolean =>
    Boolean(session && 'smartyRetainedUnavailable' in session && session.smartyRetainedUnavailable === true);

/**
 * The open ordinary session's model state, as Send's own check reads it (smarty-code#778, #790, #600): its directory's
 * sync row, else any sync row, else the global store's. A session the managed listing left out while its project stays
 * listed (`retained`, the caller's observed global-store mark) is unavailable whatever those older rows say, until a
 * listing names it again (openchamber#364 review).
 */
export function readOpenOrdinaryState(sessionId: string | null | undefined, directory: string | undefined, retained: boolean): OrdinaryModelState | undefined {
    if (!sessionId) return undefined;
    if (retained) return { generation: null, sequence: 0, model: null, thinkingLevel: null };
    return readOrdinaryModel(getSyncSessions(directory).find(session => session.id === sessionId))
        ?? readOrdinaryModel(getAllSyncSessions().find(session => session.id === sessionId))
        ?? readOrdinaryModel(useGlobalSessionsStore.getState().entityById.get(sessionId));
}
