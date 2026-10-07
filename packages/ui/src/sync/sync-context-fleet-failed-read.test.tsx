import { expect, test } from 'bun:test'
import { act } from 'react'
import { useProjectsStore } from '../stores/useProjectsStore'
import { applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from './global-session-status'
import { isStatusUnavailable } from './status-unavailable'
import { B, busy, deferred, drain, fixture } from './async-publication-fixture'
import type { SessionStatus } from './session-status'

// F-01: only a successful, current fleet sample that lists a directory unknown may spend its grace or clear its
// activity. A failed fleet read (HTTP 503 -> null) is neither another unknown sample nor authoritative empty success.
const unknown = '/fleet-failed-read/unknown'
const retry: SessionStatus = { type: 'retry', attempt: 1, message: 'retrying', next: 1 }
const mark = { 'smarty.unknown': [{ directory: unknown, status: 503 }] }

test('a failed fleet read between two unknown samples neither spends grace nor clears child-backed activity', async () => fixture(async ({ runtime, entered, release, reads }) => {
  await entered; release({}); await drain()
  useProjectsStore.setState({ managedCatalogAdmitted: true })
  const a = runtime.childStores.ensureChild(unknown, { bootstrap: false })
  a.setState({ session_status: { 'old-a': busy } })
  applyGlobalSessionStatusSnapshot(unknown, { 'old-a': busy })
  const b = runtime.childStores.ensureChild(B, { bootstrap: false })
  b.setState({ session_status: { 'healthy-b': busy } })
  applyGlobalSessionStatusSnapshot(B, { 'healthy-b': busy })
  const original = globalThis.fetch
  const location = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', { configurable: true, value: new URL('https://fixture.invalid') })
  let enteredPoll = deferred<void>(), reply = deferred<Response>()
  let scopedB: SessionStatus = busy
  globalThis.fetch = async (input, init) => {
    const url = new URL(new Request(input, init).url)
    if (url.pathname.endsWith('/session/status')) {
      const directory = url.searchParams.get('directory')
      if (directory !== null) {
        reads.push(directory)
        return Response.json(directory === B ? { 'healthy-b': scopedB } : {})
      }
      reads.push(`fleet?unknown=${url.searchParams.get('unknown')}`)
      enteredPoll.resolve(undefined)
      return reply.promise
    }
    return original(input, init)
  }
  const poll = async (answer: Response) => {
    await act(async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([enteredPoll.promise, new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('watchdog did not read within 6.5s')), 6500)
        })])
      } finally { clearTimeout(deadline) }
      reply.resolve(answer)
    })
    await drain()
    enteredPoll = deferred<void>(); reply = deferred<Response>()
  }
  const activeA = () => useGlobalSessionStatusStore.getState().activeSessionIds.has('old-a')
  reads.length = 0
  try {
    // Poll 1, successful unknown sample: A's last status is kept for this one poll (grace now held).
    await poll(Response.json({ 'healthy-b': retry, ...mark }))
    expect(isStatusUnavailable(unknown)).toBe(true)
    expect(a.getState().session_status['old-a']).toEqual(busy)
    expect(activeA()).toBe(true)
    expect(b.getState().session_status['healthy-b']).toEqual(retry)

    // Poll 2, HTTP 503: nothing about A changes; healthy B keeps its existing fallback to its own scoped read.
    scopedB = busy
    await poll(new Response(null, { status: 503 }))
    expect(isStatusUnavailable(unknown)).toBe(true)
    expect(a.getState().session_status['old-a']).toEqual(busy)
    expect(activeA()).toBe(true)
    expect(reads).toContain(B)
    expect(b.getState().session_status['healthy-b']).toEqual(busy)

    // Poll 3, successful unknown sample again: the held grace is spent now, so A's busy clears.
    await poll(Response.json({ 'healthy-b': retry, ...mark }))
    expect(a.getState().session_status['old-a']?.type).toBe('idle')
    expect(activeA()).toBe(false)
    expect(b.getState().session_status['healthy-b']).toEqual(retry)
    expect(useGlobalSessionStatusStore.getState().activeSessionIds.has('healthy-b')).toBe(true)

    expect(reads.filter(read => read === 'fleet?unknown=1')).toHaveLength(3)
    expect(reads).not.toContain(unknown)
  } finally {
    reply.resolve(Response.json({})); globalThis.fetch = original
    if (location) Object.defineProperty(window, 'location', location)
    else Reflect.deleteProperty(window, 'location')
  }
}), 30_000)
