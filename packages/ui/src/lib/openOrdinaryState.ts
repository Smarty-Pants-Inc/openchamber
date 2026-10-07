import type { Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';
import { isHerdrEnded, isOrdinaryReloading } from '@/lib/herdrSession';
import { selectedOwnerOrdinaryState } from '@/sync/selected-session-owner';
import { readOrdinaryModel, type OrdinaryModelState } from '@/lib/opencode/ordinaryModel';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { getSyncSessionRows } from '@/sync/sync-refs';
import { getImperativeSessionMessageLoader } from '@/sync/session-message-loader';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';

/** The global store's mark on an open session one managed listing left out (smarty-code#600): kept, unavailable. */
export const isRetainedUnavailable = (session: Session | undefined): boolean =>
    Boolean(session && 'smartyRetainedUnavailable' in session && session.smartyRetainedUnavailable === true);

/**
 * The global (managed listing) row says the open session cannot take a message now, whatever its older directory row
 * says: one listing left it out (the retained mark, #600), or its Pi has ended (herdrState 'ended', smarty-code#811: on a
 * busy fleet the directory row can miss that update, as the directory stream closes whenever any row leaves).
 */
export const isGloballyUnavailable = (session: Session | undefined): boolean => isRetainedUnavailable(session) || isHerdrEnded(session);

const unavailable: OrdinaryModelState = { generation: null, sequence: 0, model: null, thinkingLevel: null };
const nativeCreationSchema = z.object({ nativeCreation: z.object({ model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }) }) });
/** A Code-created session's creation-time model (smarty-code#1378 native create-only). */
function creationModel(session: Session | undefined): OrdinaryModelState | undefined {
    const parsed = nativeCreationSchema.safeParse(session);
    if (!parsed.success) return undefined;
    const { providerID, modelID } = parsed.data.nativeCreation.model;
    return { generation: null, sequence: 0, model: { providerID, modelID, name: modelID }, thinkingLevel: null };
}

/**
 * smarty-code#1427: THE ordinary (Pi) classification and model source for a session, used by the composer, the Send
 * route and its final dispatch checks alike. Undefined means stock: no source says ordinary.
 *
 * In order: the selected owner's verified state; any directory's row for the session (the target directory first, and
 * no row in one directory masks another's); the global listing, only while no directory has a row yet (a live directory
 * row outranks a possibly stale global row); then a loader view accepted as ordinary history, which proves ownership but
 * names no model, so a Code-created session's creation model stands in for it. A target row that is reloading or ended
 * is unavailable. The global listing's retained-unavailable or ended mark overrides any directory row. Unavailable
 * (no model) means ordinary but not sendable now: callers refuse rather than fall back to stock.
 */
export function readOrdinaryOwner(runtimeKey: string, sessionId: string, directory: string | undefined): OrdinaryModelState | undefined {
    const ownerState = selectedOwnerOrdinaryState(sessionId, directory);
    if (ownerState) return ownerState;
    const target = normalizePath(directory) ?? undefined;
    const rows = getSyncSessionRows(sessionId);
    const global = useGlobalSessionsStore.getState().entityById.get(sessionId);
    // A row whose own directory is not the target says ordinary, but not that the target can send to it now.
    const owns = (session: Session | undefined) => Boolean(session) && (target === undefined || normalizePath(session?.directory) === target);
    const ordinaryRows = rows.filter(row => readOrdinaryModel(row) !== undefined);
    const sources = rows.length > 0 ? ordinaryRows : global && readOrdinaryModel(global) !== undefined ? [global] : [];
    const state = sources.length > 0 ? readOrdinaryModel(sources.find(owns)) ?? unavailable : undefined;
    const loader = getImperativeSessionMessageLoader(), view = { sessionID: sessionId, directory: directory ?? '' };
    const loaderOrdinary = Boolean(loader && (loader.isOrdinary(view, runtimeKey) || loader.getSendableOrdinaryView(view, runtimeKey)));
    if (!state && !loaderOrdinary) return undefined;
    if (isGloballyUnavailable(global)) return unavailable;
    // The row this Send goes to says its Pi is reloading or has ended: ordinary, but not sendable now.
    const own = rows.find(owns);
    if (own && (isOrdinaryReloading(own) || isHerdrEnded(own))) return unavailable;
    return state ?? creationModel(rows.find(owns) ?? (owns(global) ? global : undefined)) ?? unavailable;
}

/**
 * The open session's model state as the composer shows and sends it: the same source as `readOrdinaryOwner`. A session
 * the managed listing left out while its project stays listed (`retained`, the caller's observed global-store mark) is
 * unavailable, until a listing names it again (openchamber#364 review).
 */
export function readOpenOrdinaryState(sessionId: string | null | undefined, directory: string | undefined, retained: boolean,
    runtimeKey = getRuntimeKey()): OrdinaryModelState | undefined {
    if (!sessionId) return undefined;
    const ownerState = selectedOwnerOrdinaryState(sessionId, directory);
    if (ownerState) return ownerState;
    if (retained) return unavailable;
    return readOrdinaryOwner(runtimeKey, sessionId, directory);
}
