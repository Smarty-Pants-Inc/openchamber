import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Event } from '@opencode-ai/sdk/v2/client'
import { installHookTestDom } from '../components/session/sidebar/test-utils/testDom'
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '../lib/runtime-switch'
import { clearRuntimeUrlAuthToken, getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, refreshRuntimeUrlAuthToken } from '../lib/runtime-auth'
import { getRuntimeUrlResolver, setRuntimeUrlResolver } from '../lib/runtime-url'
import { opencodeClient } from '../lib/opencode/client'
import { useConfigStore } from '../stores/useConfigStore'
import { useProjectsStore } from '../stores/useProjectsStore'
import { SyncProvider, useSyncRuntime } from './sync-context'
import { applyDirectoryEvent } from './event-reducer'
import { applyGlobalSessionStatusEvent, replaceGlobalSessionStatusById } from './global-session-status'
import { resetSessionOrdering, useSessionOrderingStore } from './session-ordering'
import { resetSessionActivityTiming, useSessionActivityTimingStore } from './session-activity-timing'
import { recordStatusUnavailable } from './status-unavailable'
import type { SessionStatus } from './session-status'

export const A = '/async-publication/a', B = '/async-publication/b'
export const busy: SessionStatus = { type: 'busy' }, idle: SessionStatus = { type: 'idle' }
export function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred not initialized') }
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
export const lifecycle = (id: string) => ({ rank: useSessionOrderingStore.getState().rankById.get(id),
  start: useSessionActivityTimingStore.getState().startedAt.get(id), settled: useSessionActivityTimingStore.getState().settledMs.get(id) })

export async function fixture(run: (input: {
  runtime: ReturnType<typeof useSyncRuntime>, entered: Promise<void>, release: (raw: Record<string, SessionStatus>) => void,
  event: (id: string, status: SessionStatus) => void, deleted: (id: string) => void,
  reads: string[], holdFleet: () => void,
}) => Promise<void>) {
  const endpoint = {
    apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey(),
    clientToken: getRuntimeBearerTokenSync(), requestHeaders: getRuntimeExtraHeadersSync(),
  }
  const resolver = getRuntimeUrlResolver(), config = useConfigStore.getState()
  const dom = installHookTestDom(), originalFetch = globalThis.fetch
  const injected = new Map(['__OPENCHAMBER_API_BASE_URL__', '__OPENCHAMBER_CLIENT_TOKEN__', '__OPENCHAMBER_RUNTIME_HEADERS__']
    .map(key => [key, Object.getOwnPropertyDescriptor(window, key)]))
  const root = createRoot(dom.container), catalog = useProjectsStore.getState()
  const entered = deferred<void>(), response = deferred<Response>()
  let fleetHeld = false, released = false
  const reads: string[] = []
  Object.assign(document, { hasFocus: () => true, visibilityState: 'visible' })
  replaceGlobalSessionStatusById(new Map()); resetSessionOrdering(); resetSessionActivityTiming(); recordStatusUnavailable([])
  switchRuntimeEndpoint({ apiBaseUrl: 'https://async-publication.invalid', runtimeKey: 'async-publication', clientToken: 'fixture' })
  opencodeClient.reconnectToRuntimeBaseUrl()
  useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: false })
  useProjectsStore.setState({ managedCatalogAdmitted: false })
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), path = url.pathname.replace(/^\/api/, '')
    if (path === '/auth/url-token') return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 })
    if (path === '/global/event') return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ directory: A, payload: { id: 'connected', type: 'server.connected', properties: {} } })}\n\n`))
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (path === '/session/status') {
      const directory = url.searchParams.get('directory') ?? 'fleet'; reads.push(directory)
      if ((!released && directory === A) || (fleetHeld && directory === 'fleet')) { entered.resolve(undefined); return response.promise }
      return Response.json({})
    }
    if (path === '/path') return Response.json({ state: '', config: '', worktree: A, directory: A, home: '/home' })
    if (path === '/project/current') return Response.json({ id: 'project', worktree: A })
    if (path === '/config' || path === '/global/config') return Response.json({})
    return Response.json([])
  }
  let runtime!: ReturnType<typeof useSyncRuntime>
  const Selected = () => { runtime = useSyncRuntime(); return null }
  try {
    await act(async () => root.render(<SyncProvider sdk={opencodeClient.getSdkClient()} directory={A}><Selected /></SyncProvider>))
    const store = runtime.childStores.ensureChild(A, { bootstrap: false })
    const dispatch = (payload: Event) => {
      applyGlobalSessionStatusEvent(A, payload)
      store.setState((state) => { const draft = { ...state, session_status: { ...state.session_status } }; applyDirectoryEvent(draft, payload); return draft })
    }
    await run({ runtime, entered: entered.promise, reads,
      release: (raw) => { released = true; response.resolve(Response.json(raw)) },
      holdFleet: () => { fleetHeld = true },
      event: (id, status) => dispatch({ id: `${id}-${status.type}`, type: 'session.status', properties: { sessionID: id, status } }),
      deleted: (id) => dispatch({ id: `${id}-deleted`, type: 'session.deleted', properties: { sessionID: id, info: {
        id, directory: A, slug: id, projectID: 'project', title: id, version: '1', time: { created: 1, updated: 1 },
      } } }),
    })
  } finally {
    response.resolve(Response.json({}))
    await act(async () => { await new Promise(done => setTimeout(done, 30)); root.unmount() })
    useProjectsStore.setState(catalog, true); recordStatusUnavailable([])
    replaceGlobalSessionStatusById(new Map()); resetSessionOrdering(); resetSessionActivityTiming()
    switchRuntimeEndpoint(endpoint)
    // Drain the switch's URL-auth mint while HTTP is still stubbed; never mint against the prior server.
    await refreshRuntimeUrlAuthToken(endpoint.apiBaseUrl).catch(() => {})
    clearRuntimeUrlAuthToken()
    setRuntimeUrlResolver(resolver)
    opencodeClient.reconnectToRuntimeBaseUrl()
    useConfigStore.setState(config, true)
    for (const [key, descriptor] of injected) {
      if (descriptor) Object.defineProperty(window, key, descriptor)
      else Reflect.deleteProperty(window, key)
    }
    globalThis.fetch = originalFetch; dom.restore()
  }
}
export const drain = () => act(async () => { await new Promise(done => setTimeout(done, 100)) })
