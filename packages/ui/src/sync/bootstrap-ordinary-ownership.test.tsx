import { expect, test } from 'bun:test'
import { applyGlobalSessionStatusEvent, getSessionStatusEventVersion, useGlobalSessionStatusStore } from './global-session-status'
import { useSessionActivityTimingStore } from './session-activity-timing'
import { useSessionOrderingStore } from './session-ordering'
import type { SessionStatus } from './session-status'
import { A, B, busy, idle, deferred, lifecycle, fixture, drain } from './async-publication-fixture'

const ordinary: SessionStatus = { type: 'busy', ordinary: true,
  ordinaryTarget: { generation: 'ordinary-generation', presentationId: 'ordinary-presentation' } }

for (const kind of ['busy', 'idle', 'omission'] as const) {
  test(`fresh foreign bootstrap ${kind} preserves ordinary owner and its lifecycle`, async () => fixture(async ({ runtime, entered, release, event }) => {
    await entered; release({}); await drain()
    const id = 'ordinary-target', store = runtime.childStores.getChild(A)!
    event(id, ordinary)
    // Containment in A is not ownership: the live index records B as the owner.
    applyGlobalSessionStatusEvent(B, { id: 'foreign-owner', type: 'session.status', properties: { sessionID: id, status: ordinary } })
    const local = store.getState().session_status[id], indexed = useGlobalSessionStatusStore.getState()
    const before = lifecycle(id), revision = getSessionStatusEventVersion(id)
    const ranks = new Map(useSessionOrderingStore.getState().rankById)
    const starts = new Map(useSessionActivityTimingStore.getState().startedAt)
    const settlements = new Map(useSessionActivityTimingStore.getState().settledMs)
    const original = globalThis.fetch, started = deferred<void>(), response = deferred<Response>()
    const reads: string[] = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url)
      if (url.pathname.endsWith('/session/status')) { reads.push(url.searchParams.get('directory') ?? 'fleet'); started.resolve(undefined); return response.promise }
      return original(input, init)
    }
    try {
      runtime.childStores.requestBootstrap({ directory: A, priority: 'selected', reason: 'action-demand', force: true })
      await started.promise
      response.resolve(Response.json(kind === 'omission' ? {} : { [id]: kind === 'busy' ? busy : idle })); await drain()
      expect(reads).toEqual([A])
      expect(store.getState().sessionStatusReady).toBe(true)
      expect(store.getState().session_status[id]).toBe(local)
      expect(store.getState().session_status[id]?.ordinaryTarget).toBe(local?.ordinaryTarget)
      expect(useGlobalSessionStatusStore.getState().statusById.get(id)).toBe(indexed.statusById.get(id))
      expect(useGlobalSessionStatusStore.getState().activeSessionIds).toBe(indexed.activeSessionIds)
      expect(lifecycle(id)).toEqual(before)
      expect(getSessionStatusEventVersion(id)).toBe(revision)
      expect(useSessionOrderingStore.getState().rankById).toEqual(ranks)
      expect(useSessionActivityTimingStore.getState().startedAt).toEqual(starts)
      expect(useSessionActivityTimingStore.getState().settledMs).toEqual(settlements)
    } finally { response.resolve(Response.json({})); globalThis.fetch = original }
  }))
}

for (const kind of ['own ordinary idle', 'managed idle', 'managed omission', 'fresh managed busy'] as const) {
  test(`fresh bootstrap accepts ${kind}`, async () => fixture(async ({ runtime, entered, release, event }) => {
    await entered; release({}); await drain()
    const id = 'authoritative-control', store = runtime.childStores.getChild(A)!
    const initial = kind === 'own ordinary idle' ? ordinary : busy
    event(id, initial)
    // Unmarked managed statuses retain their existing authoritative behavior even with a foreign index entry.
    if (kind !== 'own ordinary idle') applyGlobalSessionStatusEvent(B, { id: 'managed-owner', type: 'session.status', properties: { sessionID: id, status: busy } })
    // Omission needs existing session-list coverage, as on a populated directory.
    store.setState({ session: [{ id, directory: A, slug: id, projectID: 'project', title: id, version: '1', time: { created: 1, updated: 1 } }] })
    const before = lifecycle(id), revision = getSessionStatusEventVersion(id)
    const settlements = new Set(useSessionActivityTimingStore.getState().settledMs.keys())
    const original = globalThis.fetch, started = deferred<void>(), response = deferred<Response>()
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname.endsWith('/session/status')) { started.resolve(undefined); return response.promise }
      return original(input, init)
    }
    try {
      runtime.childStores.requestBootstrap({ directory: A, priority: 'selected', reason: 'action-demand', force: true })
      await started.promise
      const active = kind === 'fresh managed busy', omitted = kind === 'managed omission'
      response.resolve(Response.json(omitted ? {} : { [id]: active ? busy : idle })); await drain()
      expect(store.getState().session_status[id]).toEqual(omitted ? undefined : active ? busy : kind === 'own ordinary idle' ? { type: 'idle', ordinary: true, ordinaryTarget: null } : idle)
      expect(useGlobalSessionStatusStore.getState().activeSessionIds.has(id)).toBe(active)
      expect(getSessionStatusEventVersion(id)).toBe(revision)
      if (active) {
        expect(useGlobalSessionStatusStore.getState().statusById.get(id)?.directory).toBe(A)
        expect(lifecycle(id)).toEqual(before)
        expect(new Set(useSessionActivityTimingStore.getState().settledMs.keys())).toEqual(settlements)
      } else {
        expect(useGlobalSessionStatusStore.getState().statusById.has(id)).toBe(false)
        expect(lifecycle(id).start).toBeUndefined()
        expect(lifecycle(id).settled).toBeDefined()
        expect([...useSessionActivityTimingStore.getState().settledMs.keys()].filter(key => !settlements.has(key))).toEqual([id])
      }
    } finally { response.resolve(Response.json({})); globalThis.fetch = original }
  }))
}
