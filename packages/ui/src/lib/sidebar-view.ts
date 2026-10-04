import { useEffect } from 'react';
import { create } from 'zustand';
import { z } from 'zod';
import { toast } from 'sonner';
import { useHumanAuth } from './human-auth';
import { useAuthSessionStore } from './runtime-auth-expiry';
import { runtimeFetch } from './runtime-fetch';
import { captureRuntimeRequestScope, isRuntimeRequestScopeCurrent, subscribeRuntimeEndpointChanged } from './runtime-switch';
import { formatMessage, useI18nStore } from './i18n/store';

const maps = z.record(z.string(), z.boolean());
const responseSchema = z.object({
  owner: z.object({ issuer: z.string().min(1), subject: z.string().min(1) }),
  projects: maps, groups: maps,
});
type Patch = { projects?: Record<string, boolean>; groups?: Record<string, boolean> };
type Owner = z.infer<typeof responseSchema>['owner'];
type Snapshot = { ready: boolean; projects: Record<string, boolean>; groups: Record<string, boolean> };
const empty: Snapshot = { ready: false, projects: {}, groups: {} };
const useView = create<Snapshot>(() => empty);
type Entry = {
  admission: symbol;
  scope: ReturnType<typeof captureRuntimeRequestScope>;
  owner: z.infer<typeof responseSchema>['owner'] | null;
  load: Promise<void> | null;
  hydrating: Promise<void> | null;
  tail: Promise<void>;
  revisions: { projects: Map<string, symbol>; groups: Map<string, symbol> };
  confirmed: { projects: Record<string, boolean>; groups: Record<string, boolean> };
  readRevision: number;
};
const newEntry = (): Entry => ({
  admission: Symbol('sidebar preference admission'),
  scope: captureRuntimeRequestScope(), owner: null, load: null, hydrating: null, tail: Promise.resolve(),
  revisions: { projects: new Map(), groups: new Map() }, confirmed: { projects: {}, groups: {} }, readRevision: 0,
});
const mutationListeners = new Set<(patch: Patch) => void>();
export function subscribePersonalSidebarViewMutations(listener: (patch: Patch) => void): () => void {
  mutationListeners.add(listener);
  return () => { mutationListeners.delete(listener); };
}
let entry = newEntry();
let consumers = 0;
let idleAdmissionCaptured = false;
let publishingOwnerRecovery = false;
const unlocked = () => useHumanAuth.getState().enabled && useAuthSessionStore.getState().state === 'ok';
const current = (captured: typeof entry) => captured === entry && unlocked() && isRuntimeRequestScopeCurrent(captured.scope);
const notifyFailure = () => toast.error(formatMessage(useI18nStore.getState().dictionary, 'desktopHostSwitcher.error.failedToSave'));
const retire = () => { entry = newEntry(); useView.setState(empty, true); };

/** Capture before asynchronous open/create work; healthy mounting cannot renew or revoke it. */
export function capturePersonalSidebarAdmission(): symbol {
  if (!isRuntimeRequestScopeCurrent(entry.scope)) retire();
  if (!consumers) idleAdmissionCaptured = true;
  return entry.admission;
}
export function isPersonalSidebarAdmissionCurrent(admission: symbol): boolean {
  return admission === entry.admission && isRuntimeRequestScopeCurrent(entry.scope);
}

const sameOwner = (left: Owner, right: Owner): boolean => left.issuer === right.issuer && left.subject === right.subject;

async function hydrate(captured: typeof entry, force = false): Promise<void> {
  // First admission owns queued choices until it resolves; focus must join it.
  if (!captured.owner) force = false;
  // Forced revalidation must be a new read. It may supersede an older read
  // whose cookie/owner was captured before a person change.
  if (!force && captured.hydrating) return captured.hydrating;
  if (!force && captured.load) return captured.load;
  const readRevision = ++captured.readRevision;
  const request = (async () => {
    if (!current(captured)) throw new Error('Sidebar preference scope retired');
    const response = await runtimeFetch('/api/config/sidebar-view', { cache: 'no-store', credentials: 'include' });
    if (!response.ok) throw new Error(`Sidebar preference read failed (${response.status})`);
    const data = responseSchema.parse(await response.json());
    if (!current(captured) || captured.readRevision !== readRevision) return;

    const target = captured.owner && !sameOwner(captured.owner, data.owner) ? (() => {
      // This authenticated GET admits a new person. Revoke A-scoped requests
      // and tab receipts before publishing B's maps.
      publishingOwnerRecovery = true;
      try { useAuthSessionStore.getState().markAuthenticated(); }
      finally { publishingOwnerRecovery = false; }
      retire();
      return entry;
    })() : captured;
    target.owner = data.owner;
    target.confirmed = { projects: data.projects, groups: data.groups };
    target.load ??= Promise.resolve();
    // Local choices made during this GET outrank its older snapshot. A person
    // change has already retired the old local choices above.
    const local = target === captured ? useView.getState() : empty;
    useView.setState({ ready: true, projects: { ...data.projects, ...local.projects }, groups: { ...data.groups, ...local.groups } });
  })();
  captured.hydrating = request;
  if (!force) captured.load = request;
  try { await request; } catch (error) {
    if (captured.readRevision !== readRevision) return;
    if (!force) captured.load = null;
    if (current(captured) && !captured.owner) {
      // Failed admission retires all queued choices and optimistic values.
      notifyFailure();
      retire();
    }
    throw error;
  } finally {
    if (captured.hydrating === request) captured.hydrating = null;
  }
}

/** Sparse, serialized writes. The GET owner is an expected-person guard, never a storage selector. */
export async function setPersonalSidebarView(patch: Patch, admission = capturePersonalSidebarAdmission()): Promise<void> {
  if (!isPersonalSidebarAdmissionCurrent(admission)) throw new Error('Sidebar preference admission retired');
  if (!current(entry)) {
    if (!isRuntimeRequestScopeCurrent(entry.scope)) retire();
    if (!unlocked()) throw new Error('Sidebar preferences require an unlocked human session');
  }
  const captured = entry;
  const token = Symbol();
  const before = useView.getState();
  // Copy input before yielding; callers cannot retarget a queued mutation.
  const changes: Patch = {};
  if (patch.projects) changes.projects = maps.parse(patch.projects);
  if (patch.groups) changes.groups = maps.parse(patch.groups);
  for (const listener of mutationListeners) listener(changes);
  for (const field of ['projects', 'groups'] as const) {
    for (const key of Object.keys(changes[field] ?? {})) captured.revisions[field].set(key, token);
  }
  useView.setState({
    projects: changes.projects ? { ...before.projects, ...changes.projects } : before.projects,
    groups: changes.groups ? { ...before.groups, ...changes.groups } : before.groups,
  });
  const save = captured.tail.then(async () => {
    await hydrate(captured);
    if (!current(captured) || captured.admission !== admission || !captured.owner) throw new Error('Sidebar preference scope retired');
    const response = await runtimeFetch('/api/config/sidebar-view', {
      method: 'PATCH', credentials: 'include', cache: 'no-store', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: captured.owner, ...changes }),
    });
    if (response.status === 409 && current(captured)) {
      // The protected route admitted a different person. Revoke old tab/request
      // authority through verified recovery, and never retarget queued choices.
      notifyFailure();
      retire();
      useAuthSessionStore.getState().markAuthenticated();
      if (!isRuntimeRequestScopeCurrent(entry.scope)) retire();
      hydrateCurrent();
    }
    if (!response.ok) throw new Error(`Sidebar preference save failed (${response.status})`);
    // Accepted sparse changes advance rollback authority, never an older full-map echo.
    if (current(captured)) {
      for (const field of ['projects', 'groups'] as const) {
        if (changes[field]) captured.confirmed[field] = { ...captured.confirmed[field], ...changes[field] };
      }
    }
  });
  captured.tail = save.catch(() => undefined); // Only queue continuation absorbs rejection; the caller receives it below.
  try { await save; } catch (error) {
    if (current(captured)) {
      const state = useView.getState();
      const rollback: Patch = {};
      for (const field of ['projects', 'groups'] as const) {
        if (!changes[field]) continue;
        const values = { ...state[field] };
        for (const key of Object.keys(changes[field])) {
          if (captured.revisions[field].get(key) !== token) continue;
          if (Object.hasOwn(captured.confirmed[field], key)) values[key] = captured.confirmed[field][key]; else delete values[key];
        }
        rollback[field] = values;
      }
      useView.setState(rollback);
    }
    if (current(captured)) notifyFailure();
    throw error;
  }
}

/** Stable person identity admitted by the preference GET, not asynchronously cached humanSelf. */
export async function readPersonalSidebarOwner(scope: ReturnType<typeof captureRuntimeRequestScope>) {
  if (!isRuntimeRequestScopeCurrent(scope) || !unlocked()) return null;
  if (!isRuntimeRequestScopeCurrent(entry.scope)) retire();
  const captured = entry;
  if (!consumers && !captured.owner) idleAdmissionCaptured = true;
  // Before first admission, readers share its healthy initiating GET. Once an
  // owner is known, checking it is a forced revalidation, never an old read join.
  try { await hydrate(captured, captured.owner !== null); } catch (error) {
    // A read may join an independently running successor, but cannot renew action authority.
    if (!isRuntimeRequestScopeCurrent(scope)) return null;
    if (captured === entry || !entry.load) throw error;
    await hydrate(entry);
  }
  return current(entry) && isRuntimeRequestScopeCurrent(scope) ? entry.owner : null;
}

function hydrateCurrent(force = false) {
  const captured = entry;
  void hydrate(captured, force).catch(() => { if (current(captured)) notifyFailure(); });
}

let dispose = () => {};
function acquire() {
  if (consumers++ === 0) {
    const refresh = () => {
      retire();
      if (unlocked()) hydrateCurrent();
    };
    const revalidate = () => { if (unlocked()) hydrateCurrent(true); };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    const releases = [subscribeRuntimeEndpointChanged(refresh), useHumanAuth.subscribe(refresh),
      useAuthSessionStore.subscribe((state, before) => {
        // The authenticated owner-changing GET itself supplies the new maps.
        // Only its synchronous recovery publication skips a redundant admission GET.
        if (!publishingOwnerRecovery && (state.state !== before.state || state.recoveryGeneration !== before.recoveryGeneration)) refresh();
      }),
      () => window.removeEventListener('focus', revalidate),
      () => document.removeEventListener('visibilitychange', revalidate)];
    dispose = () => releases.forEach(release => release());
    // Only fresh idle captures retain known ownership without a new GET; ordinary remounts retire it.
    if (!isRuntimeRequestScopeCurrent(entry.scope) || (entry.owner && !idleAdmissionCaptured)) retire();
    if (unlocked()) hydrateCurrent();
  }
  return () => { if (--consumers === 0) {
    dispose(); // Keep only capture metadata through StrictMode's synchronous cleanup/setup.
    queueMicrotask(() => { if (!consumers) idleAdmissionCaptured = false; });
  } };
}

export function usePersonalSidebarView() {
  const enabled = useHumanAuth(state => state.enabled);
  const auth = useAuthSessionStore(state => state.state);
  const state = useView();
  useEffect(acquire, []);
  // Locking masks retired values in the same render, before any effect runs.
  return { enabled, admission: entry.admission, ...(enabled && auth === 'ok' && current(entry) ? state : empty) };
}
