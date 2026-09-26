import { afterEach, expect, test } from 'bun:test';
import { startModelPrefsAutoSave, type ModelPrefsServer } from '@/lib/modelPrefsAutoSave';
import { withoutSharingModelPrefs } from '@/lib/modelPrefsRestore';
import type { ModelPrefs } from '@/lib/modelPrefsShared';
import { useUIStore } from '@/stores/useUIStore';

// A model pick followed at once by closing (or hiding) the page was lost inside the 1.2 s debounce (Milestone 1, #126 F6).
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const empty = (): ModelPrefs => ({ favoriteModels: [], hiddenModels: [], collapsedModelProviders: [], recentModels: [], recentAgents: [], recentEfforts: {} });
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let stop: (() => void) | null = null;

afterEach(() => {
  stop?.(); stop = null;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
});

function start(initial: Partial<ModelPrefs> = {}) {
  const state = { prefs: { ...empty(), ...initial }, etag: 'v1', reads: 0,
    writes: [] as Array<{ changes: Partial<ModelPrefs>; etag: string | null; keepalive: boolean }> };
  const server: ModelPrefsServer = {
    async read() { state.reads += 1; return { prefs: structuredClone(state.prefs), etag: state.etag }; },
    async write(changes, etag, options) {
      state.writes.push({ changes: structuredClone(changes), etag, keepalive: options?.keepalive === true });
      if (etag !== state.etag) return 'conflict';
      state.prefs = { ...state.prefs, ...changes }; state.etag = 'v2';
      return 'ok';
    },
  };
  const page = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(page, {
    setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  useUIStore.setState({ recentModels: [], recentEfforts: {}, recentAgents: [], favoriteModels: [] });
  stop = startModelPrefsAutoSave(server);
  return { state, pagehide: () => page.dispatchEvent(new Event('pagehide')),
    hide: () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); } };
}

test('a pick, then unload within the debounce, sends one keepalive write with only that change', async () => {
  const kept = { providerID: 'server', modelID: 'kept' };
  const { state, pagehide } = start({ recentModels: [kept], favoriteModels: [kept] });
  useUIStore.getState().addRecentModel('anthropic', 'picked');
  await wait(0); // the batch's read has answered; the page closes well inside the debounce
  pagehide();
  await wait(0);
  expect(state.writes).toEqual([{ etag: 'v1', keepalive: true,
    changes: { recentModels: [{ providerID: 'anthropic', modelID: 'picked' }, kept] } }]);
  await wait(1300); // the debounce has nothing left to send
  expect(state.writes).toHaveLength(1);
  expect(state.reads).toBe(1);
});

test('hiding the page flushes the pending pick the same way', async () => {
  const { state, hide } = start();
  useUIStore.getState().addRecentEffort('anthropic', 'm', 'high');
  await wait(0);
  hide();
  await wait(0);
  expect(state.writes).toEqual([{ etag: 'v1', keepalive: true, changes: { recentEfforts: { 'anthropic/m': ['high'] } } }]);
});

test('an unload right after a pick still writes once the read answers', async () => {
  const { state, pagehide } = start();
  useUIStore.getState().addRecentAgent('picked-agent');
  pagehide(); // before the batch's read has answered
  await wait(0);
  expect(state.writes).toEqual([{ etag: 'v1', keepalive: true, changes: { recentAgents: ['picked-agent'] } }]);
});

test('restores and loads never flush on unload', async () => {
  const { state, pagehide, hide } = start();
  withoutSharingModelPrefs(() => useUIStore.getState().addRecentModel('anthropic', 'restored'));
  pagehide(); hide();
  await wait(1300);
  expect(state.reads).toBe(0);
  expect(state.writes).toHaveLength(0);
});
