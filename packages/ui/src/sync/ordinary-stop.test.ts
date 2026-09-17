import { afterAll, expect, test } from 'bun:test'
import type { Event } from '@opencode-ai/sdk/v2/client'
import { deferred } from '@/lib/runtime-isolation-fixture'
import { createRuntimeOpencodeClient } from '@/lib/opencode/client'
import { switchRuntimeEndpoint } from '@/lib/runtime-switch'
import { setRuntimeAuthCredentialProvider } from '@/lib/runtime-auth'
import { applyDirectoryEvent } from './event-reducer'
import { INITIAL_STATE, type State } from './types'
import { ChildStoreManager } from './child-store'
import { setSyncRefs } from './sync-refs'
import { abortCurrentOperation, setActionRefs } from './session-actions'
import { bootstrapDirectory } from './bootstrap'
import { applySessionStatusSnapshot } from './sync-context'
import { parseSessionStatus, type SessionStatus } from './session-status'

const nativeFetch = globalThis.fetch
const requests: Request[] = []
let responseStatus = 200
const a: SessionStatus = { type: 'busy', ordinary: true, ordinaryTarget: { generation: 'generation-a', presentationId: 'native-a' } }
const b: SessionStatus = { type: 'busy', ordinary: true, ordinaryTarget: { generation: 'generation-b', presentationId: 'native-b' } }
// Keep the fence through teardown; all calls in this process are synthetic.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  requests.push(request)
  const path = new URL(request.url).pathname
  if (path.endsWith('/abort')) return Response.json(responseStatus === 200 ? true : { message: 'stale ordinary target' }, { status: responseStatus })
  if (path.endsWith('/status')) return Response.json({ fixture: a, idle: { type: 'idle', ordinary: true, ordinaryTarget: null } })
  if (path.endsWith('/path')) return Response.json({ home: '/repo', directory: '/repo', worktree: '/repo', state: '', config: '' })
  return Response.json({})
}
afterAll(() => { globalThis.fetch = nativeFetch; children.disposeAll() })
switchRuntimeEndpoint({ apiBaseUrl: 'https://ordinary.test', runtimeKey: 'ordinary-test', clientToken: null })
const sdk = createRuntimeOpencodeClient({ baseUrl: 'https://ordinary.test/api' })
const children = new ChildStoreManager()
const store = children.ensureChild('/repo', { bootstrap: false })
setSyncRefs(sdk, children, '/repo')
setActionRefs(sdk, children, () => '/repo')
const event = (status: SessionStatus): Event => ({ id: 'status-event', type: 'session.status', properties: { sessionID: 'fixture', status } })

test('busy A to busy B and target removal are observable, duplicate metadata is not', () => {
  const state: State = { ...INITIAL_STATE, session_status: {} }
  expect(applyDirectoryEvent(state, event(a))).toBe(true)
  expect(applyDirectoryEvent(state, event(b))).toBe(true)
  expect(state.session_status.fixture).toEqual(b)
  expect(applyDirectoryEvent(state, event(b))).toBe(false)
  expect(applyDirectoryEvent(state, event({ type: 'busy', ordinary: true, ordinaryTarget: null }))).toBe(true)
  expect(state.session_status.fixture.ordinaryTarget).toBeNull()
  applyDirectoryEvent(state, { id: 'idle-event', type: 'session.idle', properties: { sessionID: 'fixture' } })
  expect(state.session_status.fixture).toEqual({ type: 'idle', ordinary: true, ordinaryTarget: null })
})

test('bootstrap and authoritative reconnect preserve the same ordinary metadata as SSE', async () => {
  let state: State = { ...INITIAL_STATE, session_status: {} }
  await bootstrapDirectory({ directory: '/repo', sdk, getState: () => state,
    set: (patch) => { state = { ...state, ...patch } },
    global: { config: {}, projects: [{ id: 'project', worktree: '/repo', time: { created: 1, updated: 1 }, sandboxes: [] }] },
    loadSessions: () => {},
  })
  expect(state.session_status.fixture).toEqual(a)
  expect(state.session_status.idle).toEqual({ type: 'idle', ordinary: true, ordinaryTarget: null })
  store.setState({ session_status: state.session_status })
  expect(applySessionStatusSnapshot(store, { fixture: b }, ['fixture'], 'authoritative')).toBe(true)
  expect(store.getState().session_status.fixture).toEqual(b)
  applySessionStatusSnapshot(store, { fixture: { type: 'idle', ordinary: true, ordinaryTarget: null } }, ['fixture'], 'authoritative')
  expect(store.getState().session_status.fixture).toEqual({ type: 'idle', ordinary: true, ordinaryTarget: null })
})

test('delayed Stop for displayed A stays A after B arrives and reports server refusal without retry', async () => {
  const credential = deferred<null>()
  setRuntimeAuthCredentialProvider(() => credential.promise)
  const currentSdk = createRuntimeOpencodeClient({ baseUrl: 'https://ordinary.test/api' })
  setActionRefs(currentSdk, children, () => '/repo')
  store.setState({ session_status: { fixture: a } })
  requests.length = 0
  responseStatus = 409
  const stopping = abortCurrentOperation('fixture', { status: a })
  store.setState({ session_status: { fixture: b } })
  credential.resolve(null)
  expect(await stopping).toBe(false)
  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe('POST')
  expect(requests[0].headers.get('x-smarty-ordinary-generation')).toBe('generation-a')
  expect(requests[0].headers.get('x-smarty-ordinary-presentation-id')).toBe('native-a')
  expect(new URL(requests[0].url).searchParams.get('directory')).toBe('/repo')
  responseStatus = 200
})

test('ordinary missing target refuses before HTTP; legacy Stop sends no target headers', async () => {
  requests.length = 0
  expect(await abortCurrentOperation('fixture', { status: { type: 'busy', ordinary: true, ordinaryTarget: null } })).toBe(false)
  expect(await abortCurrentOperation('fixture', { status: { type: 'idle', ordinary: true, ordinaryTarget: null } })).toBe(false)
  expect(await abortCurrentOperation('fixture')).toBe(false)
  expect(await abortCurrentOperation('fixture', { status: undefined })).toBe(false)
  expect(requests).toHaveLength(0)
  store.setState({ session_status: { fixture: { type: 'busy' } } })
  expect(await abortCurrentOperation('fixture', { status: { type: 'busy' } })).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0].headers.has('x-smarty-ordinary-generation')).toBe(false)
  expect(requests[0].headers.has('x-smarty-ordinary-presentation-id')).toBe(false)
  expect(await requests[0].text()).toBe('')
})

test('accepted ordinary B uses the paired headers and reports success', async () => {
  requests.length = 0
  store.setState({ session_status: { fixture: b } })
  expect(await abortCurrentOperation('fixture', { status: b })).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0].headers.get('x-smarty-ordinary-generation')).toBe('generation-b')
  expect(requests[0].headers.get('x-smarty-ordinary-presentation-id')).toBe('native-b')
})

test('malformed ordinary authority is rejected rather than synthesized', () => {
  expect(() => parseSessionStatus({ type: 'busy', ...{ ordinary: true, ordinaryTarget: { generation: '', presentationId: 'native-a' } } })).toThrow()
})
