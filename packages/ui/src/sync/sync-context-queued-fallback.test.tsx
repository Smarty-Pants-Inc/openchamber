import { expect, test } from 'bun:test'
import { act } from 'react'
import { getBackgroundNetworkState, runBackgroundNetworkTask } from '../lib/background-network'
import { setRuntimeBearerToken } from '../lib/runtime-auth'
import { switchRuntimeEndpoint } from '../lib/runtime-switch'
import { useProjectsStore } from '../stores/useProjectsStore'
import type { SessionStatus } from './session-status'
import { A, busy, idle, deferred, fixture, drain, lifecycle } from './async-publication-fixture'

for (const kind of ['auth', 'runtime', 'unchanged busy', 'unchanged missed idle'] as const) {
  test(`queued watchdog nonfleet direct read: ${kind}`, async () => fixture(async ({ runtime, entered, release, event }) => {
    await entered; release({}); await drain()
    expect(useProjectsStore.getState().managedCatalogAdmitted).toBe(false)
    const id = 'queued-direct'
    event(id, busy)
    const store = runtime.childStores.getChild(A)!, before = lifecycle(id)
    const original = globalThis.fetch
    const releases: Array<() => void> = []
    const blockers = Array.from({ length: 3 }, () => runBackgroundNetworkTask(() =>
      new Promise<void>(done => releases.push(done))))
    const answer: SessionStatus = kind === 'unchanged missed idle' ? idle
      : { type: 'retry', attempt: 1, message: 'fixture retry', next: 1 }
    let directoryReads = 0, fleetReads = 0
    globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url)
      if (url.pathname.endsWith('/session/status')) {
        if (!url.searchParams.has('directory')) fleetReads += 1
        if (url.searchParams.get('directory') === A) {
          directoryReads += 1
          return Response.json({ [id]: answer })
        }
      }
      return original(input, init)
    }
    try {
      await act(async () => {
        const deadline = Date.now() + 6500
        while (getBackgroundNetworkState().waiting === 0 && Date.now() < deadline) {
          await new Promise(done => setTimeout(done, 10))
        }
      })
      const queued = getBackgroundNetworkState()
      expect(releases).toHaveLength(3)
      // Stock runtimes also queue child discovery on this tick; neither task has dispatched.
      expect(queued).toEqual({ active: 3, waiting: 2, limit: 3 })
      expect(directoryReads).toBe(0)
      if (kind === 'auth') setRuntimeBearerToken('replacement-fixture')
      if (kind === 'runtime') switchRuntimeEndpoint({
        apiBaseUrl: 'https://replacement.invalid', runtimeKey: 'replacement', clientToken: 'fixture',
      })
      releases.splice(0).forEach(done => done())
      await Promise.all(blockers); await drain()
      // Discovery drains its original-SDK scope's bounded retries after a switch.
      const deadline = Date.now() + 2500
      while (getBackgroundNetworkState().active > 0 && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 10))
      }
      const changed = kind === 'auth' || kind === 'runtime'
      const current = store.getState().session_status[id]
      console.log(JSON.stringify({ path: 'nonfleet direct', kind, queued, directoryReads, fleetReads, current }))
      expect(current).toEqual(changed ? busy : answer)
      expect(directoryReads).toBe(changed ? 0 : kind === 'unchanged missed idle' ? 2 : 1)
      expect(fleetReads).toBe(0)
      if (changed) expect(lifecycle(id)).toEqual(before)
      expect(getBackgroundNetworkState()).toEqual({ active: 0, waiting: 0, limit: 3 })
    } finally {
      releases.splice(0).forEach(done => done())
      await Promise.all(blockers); await drain()
      const deadline = Date.now() + 2500
      while (getBackgroundNetworkState().active > 0 && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 10))
      }
      globalThis.fetch = original
    }
  }), 10000)
}

const retry: SessionStatus = { type: 'retry', attempt: 1, message: 'fixture retry', next: 1 }

for (const kind of ['auth', 'runtime', 'unchanged busy', 'unchanged missed idle'] as const) {
  test(`queued watchdog fleet-failure fallback: ${kind}`, async () => fixture(async ({ runtime, entered, release, event }) => {
    await entered; release({}); await drain()
    useProjectsStore.setState({ managedCatalogAdmitted: true })
    const id = 'queued-fallback'
    event(id, busy)
    const store = runtime.childStores.getChild(A)!, before = lifecycle(id)
    const original = globalThis.fetch, fleetEntered = deferred<void>()
    const releases: Array<() => void> = [], blockers: Promise<void>[] = []
    const answer = kind === 'unchanged missed idle' ? idle : retry
    let fleetReads = 0, fallbackReads = 0
    globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url)
      if (url.pathname.endsWith('/session/status') && !url.searchParams.has('directory')) {
        fleetReads += 1
        // The fleet occupies one slot. Two blockers start now; the third takes its released slot,
        // leaving the production directory fallback waiting behind three active tasks.
        blockers.push(...Array.from({ length: 3 }, () => runBackgroundNetworkTask(() =>
          new Promise<void>(done => releases.push(done)))))
        fleetEntered.resolve(undefined)
        return new Response('unavailable', { status: 503 })
      }
      if (fleetReads && url.pathname.endsWith('/session/status') && url.searchParams.get('directory') === A) {
        fallbackReads += 1
        return Response.json({ [id]: answer })
      }
      return original(input, init)
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await act(async () => {
        await Promise.race([fleetEntered.promise, new Promise<void>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('No watchdog fleet read')), 6500)
        })])
      })
      clearTimeout(timeout)
      for (let turn = 0; turn < 50 && (releases.length !== 3 || getBackgroundNetworkState().waiting === 0); turn++) {
        await new Promise(done => setTimeout(done, 10))
      }
      const queued = getBackgroundNetworkState()
      expect(releases).toHaveLength(3)
      expect(queued).toEqual({ active: 3, waiting: 1, limit: 3 })
      if (kind === 'auth') setRuntimeBearerToken('replacement-fixture')
      if (kind === 'runtime') switchRuntimeEndpoint({
        apiBaseUrl: 'https://replacement.invalid', runtimeKey: 'replacement', clientToken: 'fixture',
      })
      releases.splice(0).forEach(done => done())
      await Promise.all(blockers); await drain()
      const changed = kind === 'auth' || kind === 'runtime'
      const current = store.getState().session_status[id]
      console.log(JSON.stringify({ kind, queued, fleetReads, fallbackReads, current }))
      expect(current).toEqual(changed ? busy : answer)
      // A missed idle also invokes the existing full-resync follow-up after the fallback.
      expect(fallbackReads).toBe(changed ? 0 : kind === 'unchanged missed idle' ? 2 : 1)
      expect(fleetReads).toBe(1)
      if (changed) expect(lifecycle(id)).toEqual(before)
      expect(getBackgroundNetworkState()).toEqual({ active: 0, waiting: 0, limit: 3 })
    } finally {
      clearTimeout(timeout)
      releases.splice(0).forEach(done => done())
      await Promise.all(blockers); await drain()
      globalThis.fetch = original
    }
  }), 10000)
}
