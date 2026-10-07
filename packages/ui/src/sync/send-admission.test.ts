import { afterEach, beforeEach, expect, test } from 'bun:test';
import { sendAdmission, sendContentHash } from './send-admission';

// smarty-code#1427: the shared parts of two tabs are localStorage and the Web Lock manager. Each test gets a fresh,
// in-memory pair; a second "tab" is a second module instance reading the same storage and locks.
class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
class MemoryLocks {
  private held = new Set<string>();
  async request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => T | Promise<T>): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
  /** The browser releases every lock of a closed tab. */
  closeTab() { this.held.clear(); }
}
const original = { storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
let storage: MemoryStorage, locks: MemoryLocks;
beforeEach(() => {
  storage = new MemoryStorage(); locks = new MemoryLocks();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
});
afterEach(() => {
  for (const [key, descriptor] of [['localStorage', original.storage], ['navigator', original.navigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
const runtime = () => `admission-${crypto.randomUUID()}`;
// Another tab: a fresh module instance with no page-local claims, sharing storage and locks.
const otherTab = async () => {
  const module: typeof import('./send-admission') = await import(`./send-admission?tab=${crypto.randomUUID()}`);
  return module.sendAdmission;
};
const begin = async (admission: typeof sendAdmission, r: string, id: string, content = 'hello') => {
  const attempt = admission.begin(r, 'session', id, content);
  return attempt && await attempt.acquire() === 'acquired' ? attempt : null;
};

test('one Send per session: a second message waits; another session is independent', async () => {
  const r = runtime(), first = await begin(sendAdmission, r, 'msg_1');
  expect(first).not.toBeNull();
  expect(sendAdmission.begin(r, 'session', 'msg_2', 'other')).toBeNull();
  expect(sendAdmission.begin(r, 'session', 'msg_1', 'hello')).toBeNull(); // Not even a concurrent same-ID retry.
  expect(await begin(sendAdmission, r, 'msg_x').then(() => sendAdmission.begin(r, 'other-session', 'msg_3', 'x'))).not.toBeNull();
  first!.dispatched(); first!.accepted();
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
});

test('Astra P1: an ambiguous outcome fences other messages but admits the same message with its original ID', async () => {
  const r = runtime(), first = await begin(sendAdmission, r, 'msg_1');
  first!.dispatched(); first!.failed('unknown');
  expect(sendAdmission.unconfirmed(r, 'session')).toMatchObject({ messageID: 'msg_1', contentHash: sendContentHash('hello'), inFlight: false });
  expect(sendAdmission.begin(r, 'session', 'msg_2', 'something else')).toBeNull();
  const retry = await begin(sendAdmission, r, 'msg_1');
  expect(retry).not.toBeNull();
  retry!.dispatched(); retry!.accepted(); // Its answer settles the outcome.
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
  const next = await begin(sendAdmission, r, 'msg_2', 'a deliberate new Send');
  expect(next).not.toBeNull();
  next!.dispatched(); next!.accepted();
});

test('a retry refused for good releases; a retry that fails before leaving keeps the original unresolved', async () => {
  const r = runtime(), first = await begin(sendAdmission, r, 'msg_1');
  first!.dispatched(); first!.failed('unknown');
  const early = await begin(sendAdmission, r, 'msg_1');
  early!.failed('refused'); // Never left: says nothing about the original.
  expect(sendAdmission.unconfirmed(r, 'session')?.messageID).toBe('msg_1');
  const retry = await begin(sendAdmission, r, 'msg_1');
  retry!.dispatched(); retry!.failed('refused'); // The gateway answered: nothing was sent.
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
});

test('a failure before dispatch releases a first Send at once', async () => {
  const r = runtime(), first = await begin(sendAdmission, r, 'msg_1');
  first!.failed('unknown');
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
  expect(await begin(sendAdmission, r, 'msg_2')).not.toBeNull();
});

test('security P2: another tab cannot send a different message while one is in flight or unresolved', async () => {
  const r = runtime(), tabB = await otherTab();
  const first = await begin(sendAdmission, r, 'msg_1');
  // In flight: the lock is held, so tab B's attempt is refused when it tries to take it.
  const racing = tabB.begin(r, 'session', 'msg_b', 'hello');
  expect(racing).not.toBeNull();
  expect(await racing!.acquire()).toBe('busy');
  first!.dispatched(); first!.failed('unknown');
  // Unresolved: tab B sees it, refuses another message, and admits only the same ID.
  expect(tabB.unconfirmed(r, 'session')).toMatchObject({ messageID: 'msg_1', contentHash: sendContentHash('hello'), inFlight: false });
  expect(tabB.begin(r, 'session', 'msg_b', 'hello')).toBeNull();
  const retry = await begin(tabB, r, 'msg_1');
  expect(retry).not.toBeNull();
  retry!.dispatched(); retry!.accepted();
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
});

test('a tab closed mid-request leaves the session fenced for other messages', async () => {
  const r = runtime(), tabA = await otherTab(), tabB = await otherTab();
  const first = await begin(tabA, r, 'msg_1');
  first!.dispatched();
  // Tab A is gone: its lock is released, its marker stays.
  locks.closeTab();
  expect(tabB.unconfirmed(r, 'session')?.messageID).toBe('msg_1');
  expect(tabB.begin(r, 'session', 'msg_2', 'other')).toBeNull();
});

test('runtimes are independent for the same session ID', async () => {
  const a = runtime(), b = runtime();
  const first = await begin(sendAdmission, a, 'msg_1');
  first!.dispatched(); first!.failed('unknown');
  const other = await begin(sendAdmission, b, 'msg_2');
  expect(other).not.toBeNull();
  other!.dispatched(); other!.accepted();
  expect(sendAdmission.unconfirmed(a, 'session')?.messageID).toBe('msg_1');
});

// Security pass on a5716127, P1: admission fails closed. Without Web Locks nothing is admitted (two tabs could otherwise
// both pass); a marker the browser refuses to store stops the request before it leaves.
test('without Web Locks a Send is refused, and nothing stays claimed', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const r = runtime(), attempt = sendAdmission.begin(r, 'session', 'msg_1', 'hello');
  expect(await attempt!.acquire()).toBe('unsupported');
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
  expect(await (await otherTab()).begin(r, 'session', 'msg_2', 'other')!.acquire()).toBe('unsupported');
});

test('a marker the browser refuses to store stops the request; the session is free again', async () => {
  const r = runtime(), first = await begin(sendAdmission, r, 'msg_1');
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  expect(() => first!.dispatched()).toThrow();
  first!.failed('unknown'); // Never left: a pre-dispatch failure.
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
});

test('the marker keeps the client ID and a hash of the text, never the text', async () => {
  const r = runtime(), first = await begin(sendAdmission, r, 'msg_1', 'a private prompt');
  first!.dispatched(); first!.failed('unknown');
  const stored = storage.getItem('oc.send.unconfirmed:' + JSON.stringify([r, 'session'])) ?? '';
  expect(stored).toContain('msg_1');
  expect(stored).not.toContain('a private prompt');
  expect(sendAdmission.unconfirmed(r, 'session')?.contentHash).toBe(sendContentHash('a private prompt'));
});

// Re-audit of 2f0c8e95, P2: the same client ID with different content is not its retry, and an exact identity is kept.
test('a retry must carry the same content: the same ID with other content is refused', async () => {
  const r = runtime(), first = await begin(sendAdmission, r, 'msg_1', 'hello');
  first!.dispatched(); first!.failed('unknown');
  expect(sendContentHash(' hello\n')).not.toBe(sendContentHash('hello'));
  expect(sendAdmission.begin(r, 'session', 'msg_1', 'hello, edited')).toBeNull();
  expect(sendAdmission.begin(r, 'session', 'msg_1', ' hello\n')).toBeNull();
  expect(await begin(sendAdmission, r, 'msg_1', 'hello')).not.toBeNull();
});

// Re-audit of 2f0c8e95, P2: a value this build does not write (an earlier format kept the prompt text) is removed.
test('an unparseable or text-bearing marker is removed when read', async () => {
  const r = runtime(), key = 'oc.send.unconfirmed:' + JSON.stringify([r, 'session']);
  storage.setItem(key, JSON.stringify({ messageID: 'msg_old', content: 'an old private prompt' }));
  expect(sendAdmission.unconfirmed(r, 'session')).toBeUndefined();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(storage.getItem(key)).toBeNull();
});

// Security delta pass on 9b8fb9b7, P2: the cleanup runs under the session lock and only removes the value it read, so a
// live marker another tab writes right after this tab's read survives.
test('cleaning an old marker never erases a live one written meanwhile by another tab', async () => {
  const r = runtime(), key = 'oc.send.unconfirmed:' + JSON.stringify([r, 'session']);
  const live = JSON.stringify({ messageID: 'msg_live', contentHash: sendContentHash('live') });
  storage.setItem(key, JSON.stringify({ messageID: 'msg_old', content: 'an old private prompt' }));
  const read = storage.getItem.bind(storage);
  let raced = false;
  // Another tab writes its live marker right after this tab reads the old value.
  storage.getItem = (name: string) => {
    const value = read(name);
    if (name === key && !raced) { raced = true; storage.setItem(key, live); }
    return value;
  };
  sendAdmission.unconfirmed(r, 'session'); // Reads the old value (scheduling its cleanup); the live one lands right after.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(read(key)).toBe(live);
  expect(sendAdmission.unconfirmed(r, 'session')?.messageID).toBe('msg_live');
  expect(sendAdmission.begin(r, 'session', 'msg_other', 'other')).toBeNull();
});
