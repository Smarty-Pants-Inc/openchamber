import { expect, test } from 'bun:test'
import { act } from 'react'
import { switchRuntimeEndpoint } from '../lib/runtime-switch'
import { setRuntimeBearerToken } from '../lib/runtime-auth'
import { useProjectsStore } from '../stores/useProjectsStore'
import { useGlobalSessionStatusStore } from './global-session-status'
import { noteStatusUnavailablePoll, recordStatusUnavailable } from './status-unavailable'
import { A, B, busy, idle, deferred, lifecycle, fixture, drain } from './async-publication-fixture'

test('bootstrap production callback accepts authoritative unchanged busy without synthetic lifecycle changes', async () => fixture(async ({ runtime, entered, release }) => {
  await entered; release({ 'control-busy': busy }); await drain()
  const store = runtime.childStores.getChild(A)!, before = lifecycle('control-busy')
  const oldStatus = store.getState().session_status['control-busy']
  const original = globalThis.fetch, started = deferred<void>(), response = deferred<Response>()
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname.endsWith('/session/status')) { started.resolve(undefined); return response.promise }
    return original(input, init)
  }
  try {
    runtime.childStores.requestBootstrap({ directory: A, priority: 'selected', reason: 'action-demand', force: true })
    await started.promise
    response.resolve(Response.json({ 'control-busy': busy })); await drain()
    expect(store.getState().session_status['control-busy']).toEqual(oldStatus)
    expect(store.getState().session_status['control-busy']).not.toBe(oldStatus)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('control-busy')).toBe(true)
    expect(lifecycle('control-busy')).toEqual(before)
  } finally { response.resolve(Response.json({})); globalThis.fetch = original }
}))

for (const kind of ['runtime', 'auth', 'failure', 'disposed'] as const) {
  test(`tray production refresh preserves state on ${kind}`, async () => fixture(async ({ entered, release, event }) => {
    await entered; release({}); await drain(); event('tray-held', busy)
    const before = lifecycle('tray-held'), original = globalThis.fetch
    const { refreshTraySessionStatuses } = await import('../hooks/useTraySync')
    const response = deferred<Response>(), started = deferred<void>(); let disposed = false
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname.endsWith('/session/status')) { started.resolve(undefined); return response.promise }
      return original(input, init)
    }
    try {
      const result = refreshTraySessionStatuses(new Map([[A, ['tray-held']]]), () => disposed); await started.promise
      if (kind === 'runtime') switchRuntimeEndpoint({ apiBaseUrl: 'https://replacement.invalid', runtimeKey: 'replacement', clientToken: 'fixture' })
      if (kind === 'auth') setRuntimeBearerToken('replacement-fixture')
      if (kind === 'disposed') disposed = true
      response.resolve(kind === 'failure' ? new Response('unavailable', { status: 503 }) : Response.json({})); await result
      expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('tray-held')).toBe(true)
      expect(lifecycle('tray-held')).toEqual(before)
    } finally { response.resolve(Response.json({})); globalThis.fetch = original }
  }))
}


for (const kind of ['idle', 'already-absent delete', 'unknown raw idle', 'optimistic local'] as const) {
  test(`bootstrap production callback fences newer ${kind}`, async () => fixture(async ({ runtime, entered, event, deleted, release }) => {
    await entered
    const store = runtime.childStores.getChild(A)!, id = `bootstrap-${kind}`
    if (kind === 'idle') { event(id, busy); event(id, idle) }
    if (kind === 'unknown raw idle') event(id, idle)
    if (kind === 'already-absent delete') deleted(id)
    if (kind === 'optimistic local') store.setState({ session_status: { [id]: idle } })
    const held = store.getState().session_status[id], before = lifecycle(id)
    release({ [id]: busy }); await drain()
    expect(store.getState().session_status[id]).toEqual(held)
    expect(useGlobalSessionStatusStore.getState().statusById.has(id)).toBe(false)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has(id)).toBe(false)
    expect(lifecycle(id)).toEqual(before)
    expect(store.getState().sessionStatusReady).toBe(true)
    expect(store.getState().config).toEqual({})
  }))
}

test('bootstrap production callback keeps newer unchanged busy and repairs missed event', async () => fixture(async ({ runtime, entered, event, release }) => {
  const id = 'bootstrap-unchanged'; await entered
  event(id, busy)
  // The newer unchanged busy is held; a raw ID with no newer event repairs missing activity.
  release({ [id]: busy, 'bootstrap-missed': busy }); await drain()
  const store = runtime.childStores.getChild(A)!
  expect(store.getState().session_status[id]?.type).toBe('busy')
  expect(store.getState().session_status['bootstrap-missed']?.type).toBe('busy')
  expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('bootstrap-missed')).toBe(true)
}))

for (const kind of ['runtime', 'auth'] as const) {
  test(`bootstrap production callback rejects ${kind} switch`, async () => fixture(async ({ runtime, entered, release }) => {
    await entered; const store = runtime.childStores.getChild(A)!
    if (kind === 'auth') setRuntimeBearerToken('replacement-fixture')
    else switchRuntimeEndpoint({ apiBaseUrl: 'https://replacement.invalid', runtimeKey: 'replacement', clientToken: 'fixture' })
    release({ stale: busy }); await drain()
    expect(store.getState().session_status.stale).toBeUndefined()
    expect(store.getState().sessionStatusReady).not.toBe(true)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('stale')).toBe(false)
  }))
}

test('shared watchdog promise fences idle and optimistic updates across consumers with one read', async () => fixture(async ({ runtime, entered, event, release, holdFleet, reads }) => {
  await entered; release({}); await drain()
  useProjectsStore.setState({ managedCatalogAdmitted: true })
  const a = runtime.childStores.getChild(A)!, b = runtime.childStores.ensureChild(B, { bootstrap: false })
  event('fleet-a', busy); b.setState({ session_status: { 'fleet-b': busy } })
  // Replace HTTP only for the fleet read, with a distinct deferred response.
  const original = globalThis.fetch, fleet = deferred<Response>(), started = deferred<void>()
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.pathname.endsWith('/session/status') && !url.searchParams.has('directory')) { reads.push('held-fleet'); started.resolve(undefined); return fleet.promise }
    return original(input, init)
  }
  holdFleet(); reads.length = 0
  try {
    await act(async () => { await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('watchdog did not read')), 6500))]) })
    event('fleet-a', idle); b.setState({ session_status: { 'fleet-b': idle } })
    fleet.resolve(Response.json({ 'fleet-a': busy, 'fleet-b': busy })); await drain()
    expect(a.getState().session_status['fleet-a']).toEqual(idle)
    expect(b.getState().session_status['fleet-b']).toEqual(idle)
    expect(reads.filter(read => read === 'held-fleet')).toHaveLength(1)
  } finally { fleet.resolve(Response.json({})); globalThis.fetch = original }
}), 10000)

test('shared watchdog unknown-scope clearing holds a sibling that starts during the read', async () => fixture(async ({ runtime, entered, event, release }) => {
  await entered; release({}); await drain(); useProjectsStore.setState({ managedCatalogAdmitted: true })
  event('unknown-candidate', busy); recordStatusUnavailable([A]); noteStatusUnavailablePoll(A)
  const original = globalThis.fetch, fleet = deferred<Response>(), started = deferred<void>()
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.pathname.endsWith('/session/status') && !url.searchParams.has('directory')) { started.resolve(undefined); return fleet.promise }
    return original(input, init)
  }
  try {
    await act(async () => { await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('watchdog did not read')), 6500))]) })
    event('unknown-sibling', busy); const before = lifecycle('unknown-sibling')
    fleet.resolve(Response.json({ 'smarty.unknown': [{ directory: A, status: 503 }] })); await drain()
    expect(runtime.childStores.getChild(A)!.getState().session_status['unknown-sibling']).toEqual(busy)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('unknown-sibling')).toBe(true)
    expect(lifecycle('unknown-sibling')).toEqual(before)
  } finally { fleet.resolve(Response.json({})); globalThis.fetch = original }
}), 10000)

test('tray production refresh holds raw unknown idle, absent-deletion and local writes, but repairs missed busy', async () => fixture(async ({ runtime, entered, release, event, deleted }) => {
  await entered; release({}); await drain()
  const { refreshTraySessionStatuses } = await import('../hooks/useTraySync')
  const original = globalThis.fetch, response = deferred<Response>(), started = deferred<void>()
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname.endsWith('/session/status')) { started.resolve(undefined); return response.promise }
    return original(input, init)
  }
  try {
    const result = refreshTraySessionStatuses(new Map([[A, ['tray-known']]]), () => false); await started.promise
    event('tray-unknown', idle); deleted('tray-deleted'); event('tray-sibling', busy); const before = lifecycle('tray-unknown')
    const store = runtime.childStores.getChild(A)!
    store.setState((state) => ({ session_status: { ...state.session_status, 'tray-local': idle } }))
    response.resolve(Response.json({ 'tray-unknown': busy, 'tray-deleted': busy, 'tray-local': busy, 'tray-missed': busy })); await result
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('tray-unknown')).toBe(false)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('tray-deleted')).toBe(false)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('tray-missed')).toBe(true)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('tray-local')).toBe(false)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('tray-sibling')).toBe(true)
    expect(lifecycle('tray-unknown')).toEqual(before)
  } finally { response.resolve(Response.json({})); globalThis.fetch = original }
}))
