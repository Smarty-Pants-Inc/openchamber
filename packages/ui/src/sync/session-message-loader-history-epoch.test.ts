import { expect, test } from 'bun:test'
import { ChildStoreManager } from './child-store'
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader'
import { handleEvent, createEventRoutingIndex } from './sync-context'
import type { Event } from '@opencode-ai/sdk/v2/client'
import { fakeMessagesClient, record, target } from './session-message-loader-replace.fixture'

function setup(historyEpoch?: string) {
  const g = { epoch: 'position-one', historyEpoch, ids: ['m1', 'm2'], reads: Array<string>(),
    hold: false, release: () => {}, started: Promise.resolve(), notify: () => {} }
  g.started = new Promise<void>((resolve) => { g.notify = resolve })
  const children = new ChildStoreManager()
  const sdk = fakeMessagesClient(async (input: { limit?: number; $query_at?: number; $query_epoch?: string }) => {
    g.reads.push(input.$query_epoch ?? 'tail')
    if (input.$query_epoch && input.$query_epoch !== g.epoch) throw Object.assign(new Error('index changed'), { status: 409 })
    const start = Math.max(0, input.$query_at ?? 0)
    const headers = new Headers({ 'x-smarty-at': String(start), 'x-smarty-total': String(g.ids.length), 'x-smarty-index-epoch': g.epoch })
    if (g.historyEpoch !== undefined) headers.set('x-smarty-history-epoch', g.historyEpoch)
    const data = g.ids.slice(start, start + (input.limit ?? 50)).map(record)
    if (g.hold) { g.notify(); await new Promise<void>((resolve) => { g.release = resolve }) }
    return { data, headers }
  })
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: 'runtime-a' })
  return { g, loader, children, done() { g.release(); loader.dispose(); children.disposeAll(); setImperativeSessionMessageLoader(null) } }
}

test('range headers commit exactly one native history identity on newest and window pages', async () => {
  const s = setup('native-one')
  try {
    await s.loader.ensure(target, { reason: 'navigation' })
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ epoch: 'position-one', historyEpoch: 'native-one' })
    await s.loader.loadAt(target, 0, 1)
    expect(s.g.reads.at(-1)).toBe('position-one')
    expect(s.loader.getSnapshot(target).positions?.historyEpoch).toBe('native-one')
  } finally { s.done() }
})

test('session.index forwards native history even on same-position invisible branch rewrites', async () => {
  const s = setup('native-one')
  try {
    await s.loader.ensure(target, { reason: 'navigation' })
    setImperativeSessionMessageLoader(s.loader)
    // Gateway events extend the official SDK union. Invoke the real untyped wire receiver, not a fabricated reducer.
    const event = { id: 'history-index-event', type: 'session.index', properties: { sessionID: target.sessionID, total: 2,
      epoch: 'position-one', historyEpoch: 'native-two' } }
    // SAFETY: the gateway extends the SDK union with this session-addressed event; the real receiver checks its
    // discriminator/fields and the loader parses the native identity before granting it any authority.
    handleEvent(target.directory, event as Event, s.children, createEventRoutingIndex(), 'runtime-a')
    expect(s.loader.getSnapshot(target).positions?.historyEpoch).toBe('native-two')
  } finally { s.done() }
})

test('alias-only index churn preserves native history while clearing positional coverage and fencing late windows', async () => {
  const s = setup('native-one')
  try {
    await s.loader.ensure(target, { reason: 'navigation' })
    s.g.hold = true
    const late = s.loader.loadAt(target, 0, 1)
    await s.g.started
    s.g.hold = false; s.g.epoch = 'position-two'; s.g.ids = ['m3', 'm4']
    s.loader.noteIndex(target, 2, 'position-two', 'native-one')
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ epoch: 'position-two', historyEpoch: 'native-one', ranges: [] })
    await s.loader.refreshTail(target, 50)
    s.g.release(); await late
    expect(s.children.getChild(target.directory)?.getState().message[target.sessionID]?.map((m) => m.id)).toEqual(['m3', 'm4'])
    expect(s.loader.positionOf(target, 'm1')).toBeUndefined()
    expect(s.loader.getSnapshot(target).positions).toMatchObject({ epoch: 'position-two', historyEpoch: 'native-one', ranges: [{ start: 0, end: 2 }] })
  } finally { s.done() }
})

for (const historyEpoch of [undefined, '', '   ', 'x'.repeat(257)]) {
  test(`absent or invalid history epoch stays on the legacy positional contract (${historyEpoch?.length ?? 'absent'})`, async () => {
    const s = setup(historyEpoch)
    s.g.historyEpoch = historyEpoch
    try {
      await s.loader.ensure(target, { reason: 'navigation' })
      expect(s.loader.getSnapshot(target).positions?.historyEpoch).toBeUndefined()
      s.loader.noteIndex(target, 2, 'position-one', historyEpoch)
      expect(s.loader.getSnapshot(target).positions?.historyEpoch).toBeUndefined()
    } finally { s.done() }
  })
}

test('a header-only native rewrite fences old same-positional-epoch windows without another recovery read', async () => {
  const s = setup('native-one')
  try {
    await s.loader.ensure(target, { reason: 'navigation' })
    s.g.hold = true
    const late = s.loader.loadAt(target, 0, 1)
    await s.g.started
    s.g.hold = false; s.g.historyEpoch = 'native-two'; s.g.ids = ['m3', 'm4']
    await s.loader.refreshTail(target, 50)
    const reads = s.g.reads.length
    s.g.release(); await late
    expect(s.g.reads).toHaveLength(reads)
    expect(s.children.getChild(target.directory)?.getState().message[target.sessionID]?.map((m) => m.id)).toEqual(['m3', 'm4'])
    expect(s.loader.getSnapshot(target).positions?.historyEpoch).toBe('native-two')
  } finally { s.done() }
})

test('a native history rewrite with unchanged positional epoch still fences outstanding windows', async () => {
  const s = setup('native-one')
  try {
    await s.loader.ensure(target, { reason: 'navigation' })
    s.g.hold = true
    const late = s.loader.loadAt(target, 0, 1)
    await s.g.started
    s.g.hold = false; s.g.historyEpoch = 'native-two'; s.g.ids = ['m3', 'm4']
    s.loader.noteIndex(target, 2, 'position-one', 'native-two')
    await s.loader.refreshTail(target, 50)
    s.g.release(); await late
    expect(s.children.getChild(target.directory)?.getState().message[target.sessionID]?.map((m) => m.id)).toEqual(['m3', 'm4'])
    expect(s.loader.getSnapshot(target).positions?.historyEpoch).toBe('native-two')
  } finally { s.done() }
})
