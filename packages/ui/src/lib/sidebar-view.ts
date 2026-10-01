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
type Snapshot = { ready: boolean; projects: Record<string, boolean>; groups: Record<string, boolean> };
const empty: Snapshot = { ready: false, projects: {}, groups: {} };
const useView = create<Snapshot>(() => empty);
type Entry = {
  admission: symbol;
  scope: ReturnType<typeof captureRuntimeRequestScope>;
  owner: z.infer<typeof responseSchema>['owner'] | null;
  load: Promise<void> | null;
  tail: Promise<void>;
  revisions: { projects: Map<string, symbol>; groups: Map<string, symbol> };
  confirmed: { projects: Record<string, boolean>; groups: Record<string, boolean> };
};
const newEntry = (): Entry => ({
  admission: Symbol('sidebar preference admission'),
  scope: captureRuntimeRequestScope(), owner: null, load: null, tail: Promise.resolve(),
  revisions: { projects: new Map(), groups: new Map() }, confirmed: { projects: {}, groups: {} },
});
const mutationListeners = new Set<(patch: Patch) => void>();
export function subscribePersonalSidebarViewMutations(listener: (patch: Patch) => void): () => void {
  mutationListeners.add(listener);
  return () => { mutationListeners.delete(listener); };
}
let entry = newEntry();
let consumers = 0;
let idleAdmissionCaptured = false;
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

async function hydrate(captured: typeof entry): Promise<void> {
  if (captured.load) return captured.load;
  captured.load = (async () => {
    if (!current(captured)) throw new Error('Sidebar preference scope retired');
    const response = await runtimeFetch('/api/config/sidebar-view', { cache: 'no-store', credentials: 'include' });
    if (!response.ok) throw new Error(`Sidebar preference read failed (${response.status})`);
    const data = responseSchema.parse(await response.json());
    if (!current(captured)) throw new Error('Sidebar preference scope retired');
    captured.owner = data.owner;
    captured.confirmed = { projects: data.projects, groups: data.groups };
    // Local choices made during this GET outrank its older snapshot.
    const local = useView.getState();
    useView.setState({ ready: true, projects: { ...data.projects, ...local.projects }, groups: { ...data.groups, ...local.groups } });
  })();
  try { await captured.load; } catch (error) {
    captured.load = null;
    if (current(captured) && !captured.owner) {
      // Failed admission retires all queued choices and optimistic values.
      notifyFailure();
      retire();
    }
    throw error;
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
  try { await hydrate(captured); } catch (error) {
    // A read may join an independently running successor, but cannot renew action authority.
    if (!isRuntimeRequestScopeCurrent(scope)) return null;
    if (captured === entry || !entry.load) throw error;
    await hydrate(entry);
  }
  return current(entry) && isRuntimeRequestScopeCurrent(scope) ? entry.owner : null;
}

function hydrateCurrent() {
  const captured = entry;
  void hydrate(captured).catch(() => { if (current(captured)) notifyFailure(); });
}

let dispose = () => {};
function acquire() {
  if (consumers++ === 0) {
    const refresh = () => {
      retire();
      if (unlocked()) hydrateCurrent();
    };
    const releases = [subscribeRuntimeEndpointChanged(refresh), useHumanAuth.subscribe(refresh),
      useAuthSessionStore.subscribe((state, before) => {
        if (state.state !== before.state || state.recoveryGeneration !== before.recoveryGeneration) refresh();
      })];
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
  return { enabled, ...(enabled && auth === 'ok' && current(entry) ? state : empty) };
}
