import { expect, test } from 'bun:test'
import { opencodeClient } from '../lib/opencode/client'
import { switchRuntimeEndpoint } from '../lib/runtime-switch'
import { isStatusUnavailable, noteStatusUnavailablePoll, useStatusUnavailableStore } from './status-unavailable'
import { fixture, drain, deferred } from './async-publication-fixture'

// GREEN counterexample: runtimeFetch already fences buffered R1 bodies; this is not a new RED.
test('a buffered R1 fleet body cannot restore an unavailable marker after switching to R2', async () => fixture(async ({ entered, release }) => {
  await entered; release({}); await drain()
  const original = globalThis.fetch, reading = deferred<void>()
  const location = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', { configurable: true, value: new URL('https://fixture.invalid') })
  const body = deferred<ReadableStreamDefaultController<Uint8Array>>()
  globalThis.fetch = async (input, init) => {
    const url = new URL(new Request(input, init).url)
    if (url.pathname.endsWith('/session/status')) {
      const response = new Response(new ReadableStream<Uint8Array>({ start: body.resolve }),
        { headers: { 'content-type': 'application/json' } })
      const json = response.json.bind(response)
      response.json = () => { reading.resolve(undefined); return json() }
      return response
    }
    return original(input, init)
  }
  try {
    const read = opencodeClient.getSessionStatusForDirectory(null)
    const controller = await body.promise; await reading.promise
    switchRuntimeEndpoint({ apiBaseUrl: 'https://replacement.invalid', runtimeKey: 'replacement', clientToken: 'fixture' })
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ 'smarty.unknown': [{ directory: '/same/path', status: 503 }] })))
    controller.close()
    expect(await read).toBeNull()
    expect(isStatusUnavailable('/same/path')).toBe(false)
  } finally {
    globalThis.fetch = original
    if (location) Object.defineProperty(window, 'location', location)
    else Reflect.deleteProperty(window, 'location')
  }
}))

for (const replacement of ['stock', 'managed', 'same-key endpoint'] as const) {
  const sameKey = replacement === 'same-key endpoint'
  test(`runtime switch ${sameKey ? 'keeps' : 'retires'} unavailable notice and grace for ${replacement} at the same path`, async () => fixture(async ({ entered, release }) => {
    await entered; release({}); await drain()
    const path = '/same/path', original = globalThis.fetch
    const location = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', { configurable: true, value: new URL('https://fixture.invalid') })
    globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url)
      if (url.pathname.endsWith('/session/status')) {
        return url.searchParams.has('directory')
          ? Response.json({ replacement: { type: 'busy' } })
          : Response.json({ 'smarty.unknown': [{ directory: path, status: 503 }] })
      }
      return original(input, init)
    }
    try {
      expect(await opencodeClient.getSessionStatusForDirectory(null)).toEqual({})
      expect(isStatusUnavailable(path)).toBe(true)
      expect(noteStatusUnavailablePoll(path)).toBe(false)
      expect(noteStatusUnavailablePoll(path)).toBe(true)
      const notices: number[] = []
      const unsubscribe = useStatusUnavailableStore.subscribe(state => notices.push(state.directories.size))
      try {
        switchRuntimeEndpoint({ apiBaseUrl: 'https://replacement.invalid',
          runtimeKey: sameKey ? 'async-publication' : 'replacement', clientToken: 'fixture' })
        opencodeClient.reconnectToRuntimeBaseUrl()
        // Stock R2 has no fleet sample that could incidentally clear R1's marker.
        expect(await opencodeClient.getSessionStatusForDirectory(path)).toEqual({ replacement: { type: 'busy' } })
        if (sameKey) {
          // Same runtime, new transport: the notice and the already-held grace stay.
          expect(isStatusUnavailable(path)).toBe(true)
          expect(notices).not.toContain(0)
          expect(noteStatusUnavailablePoll(path)).toBe(true)
          return
        }
        expect(isStatusUnavailable(path)).toBe(false)
        expect(notices).toContain(0)
        if (replacement !== 'stock') {
          expect(await opencodeClient.getSessionStatusForDirectory(null)).toEqual({})
          expect(isStatusUnavailable(path)).toBe(true)
          expect(noteStatusUnavailablePoll(path)).toBe(false)
        }
      } finally { unsubscribe() }
    } finally {
      globalThis.fetch = original
      if (location) Object.defineProperty(window, 'location', location)
      else Reflect.deleteProperty(window, 'location')
    }
  }))
}
