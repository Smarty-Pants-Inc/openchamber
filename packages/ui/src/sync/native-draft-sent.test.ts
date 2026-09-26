import { afterEach, expect, test } from 'bun:test';
import { claimChatDraftOwnership, consumeChatDraft, createChatDraftIdentity, readChatDraft, subscribeChatDraftConsumption, writeChatDraft } from '@/lib/chatDraftPersistence';
import type { NativeCreationState } from '@/lib/opencode/nativeCreation';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';
import { admitSentStart, keepSentTextAsDraft, markSentStart, releaseSentStart, resetSentStartsForPage, resolveSentStart, sentStartLocks } from './native-draft-sent';

// #117 (closed-tab case on 3.20): a Send whose start the server accepted owns the draft's text until that start resolves.
// A tab closed meanwhile leaves the text in the draft; the next load or New session in that project must resolve the
// start first, and never offer that text as an ordinary editable draft.
if (!('localStorage' in globalThis)) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); }, clear: () => { store.clear(); } } });
}
// Web Locks as another live tab holds them.
const held = new Set<string>();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
  request: async (name: string, options: unknown, callback?: (lock: unknown) => unknown) => {
    const work = (callback ?? options) as (lock: unknown) => unknown;
    if (callback && (options as { ifAvailable?: boolean }).ifAvailable && held.has(name)) return work(null);
    held.add(name); try { return await work({ name }); } finally { held.delete(name); } }, query: async () => ({ held: [...held].map(name => ({ name })) }) } } });
const request = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', newer = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; localStorage.clear(); held.clear(); resetSentStartsForPage(); });
const markKey = () => `oc.nativeCreation.sent:${JSON.stringify([fixture!.runtimeA, directory])}`;
/** Another tab's Send marked it; this page did not. */
const markedElsewhere = (id = request, admitted = false) => localStorage.setItem(markKey(),
  JSON.stringify(admitted ? { clientRequestId: id, admitted, text: 'hello', at: Date.now() } : { clientRequestId: id }));
const start = (phase: NativeCreationState['phase'], native = false): NativeCreationState => {
  const value: NativeCreationState = { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directory,
    generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: 3, phase, expiresAt: Date.now() + 60_000, canInitialReady: false,
    clientRequestId: request };
  if (native) value.native = { id: session.id, generation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  return value;
};
function server(listed: NativeCreationState[], sent: string[], history: Promise<void> = Promise.resolve()) {
  fixture = nativeDraftFixture();
  const inner = globalThis.fetch;
  // SAFETY: the fixture fetch takes and returns exactly what fetch does; only Bun's extra static members differ.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith('/session/creation')) return Response.json({ nativeCreations: listed });
    if (url.pathname.endsWith(`/session/${session.id}/message`)) {
      await history;
      return Response.json(sent.map((text, i) => ({ info: { id: `msg_${i}`, sessionID: session.id, role: 'user', time: { created: 1 } },
        parts: [{ id: `prt_${i}`, sessionID: session.id, messageID: `msg_${i}`, type: 'text', text }] })));
    }
    return inner(input, init);
  }) as typeof fetch;
}
const draftId = 7;
const draft = () => createChatDraftIdentity(fixture!.runtimeA, directory, null, draftId)!;
/** The mounted composer owns this draft generation and writes its text. */
const write = (text: string) => { claimChatDraftOwnership(draft()); writeChatDraft(draft(), text, []); };
const resolve = (own?: string) => resolveSentStart(fixture!.runtimeA, directory, draftId, own);
const lock = (id = request) => `oc.nativeCreation.sending:${id}`;

test('each outcome of a sent start after a closed tab: only a stopped start or its delivered text unlocks it', async () => {
  for (const [listed, sent, admitted, outcome, marker] of [
    [[start('awaiting-trust')], [], false, 'pending', true],
    [[start('ready', true)], [], false, 'unknown', true], // No user message yet is no proof it will never arrive.
    [[start('expired')], [], false, 'stopped', false],
    [[], [], false, 'unknown', true],
    [[start('unavailable')], [], false, 'unknown', true], // Not readable: unknown, so the person can still edit it.
    [[start('ready', true)], ['hello'], false, 'delivered', true], // Its text arrived: kept, admitted, for other tabs.
    [[start('ready', true)], ['typed in the terminal'], false, 'unknown', true], // Another text is no proof this one arrived.
    [[start('ready', true)], ['hello'], true, 'delivered', true], // Another tab's Send was admitted: this copy is consumed.
  ] as const) {
    server([...listed], [...sent]);
    write('hello');
    markedElsewhere(request, admitted);
    expect(await resolve()).toBe(outcome);
    expect(localStorage.getItem(markKey()) !== null).toBe(marker);
    expect(readChatDraft(draft()).text).toBe(outcome === 'delivered' ? '' : 'hello'); // Only delivered text is consumed.
    expect(sentStartLocks(outcome)).toBe(outcome === 'pending' || outcome === 'unknown');
    fixture!.dispose(); fixture = undefined; localStorage.clear(); resetSentStartsForPage();
  }
});

test('delivered text is consumed through the mounted draft generation, so the live editor clears it too', async () => {
  server([start('ready', true)], ['hello']);
  write('hello');
  markedElsewhere();
  const seen: (number | undefined)[] = [];
  const stop = subscribeChatDraftConsumption((identity, submitted) => { if (submitted === 'hello') seen.push(identity.draftId); });
  try { expect(await resolve()).toBe('delivered'); } finally { stop(); }
  expect(seen).toEqual([draftId]);
});

test('while the sending tab is in its Send (its lock held), the text is pending, never unlocked', async () => {
  server([start('ready', true)], []);
  write('hello');
  markedElsewhere();
  held.add(lock());
  expect(await resolve()).toBe('pending');
  expect(localStorage.getItem(markKey())).not.toBeNull();
});

test('a late history answer never clears a newer mark or a newer draft text', async () => {
  let arrive = () => {};
  server([start('ready', true)], ['hello'], new Promise<void>(resolve => { arrive = resolve; }));
  write('hello');
  markedElsewhere();
  const resolving = resolve();
  await new Promise(done => setTimeout(done, 5));
  // Meanwhile another Send took this project's slot with a new text.
  write('NEW UNSENT TEXT');
  markedElsewhere(newer);
  arrive();
  await resolving;
  expect(localStorage.getItem(markKey())).toContain(newer);
  expect(readChatDraft(draft()).text).toBe('NEW UNSENT TEXT');
});

test("an older Send's admission or end never touches a newer start's mark or lock in the same page", async () => {
  server([], []);
  markSentStart(fixture!.runtimeA, directory, request);
  markSentStart(fixture!.runtimeA, directory, newer);
  await new Promise(done => setTimeout(done, 1));
  admitSentStart(fixture!.runtimeA, directory, request);
  releaseSentStart(request);
  await new Promise(done => setTimeout(done, 1));
  expect(JSON.parse(localStorage.getItem(markKey())!)).toEqual({ clientRequestId: newer });
  expect([...held]).toEqual([lock(newer)]);
  admitSentStart(fixture!.runtimeA, directory, newer);
  await new Promise(done => setTimeout(done, 1));
  expect(JSON.parse(localStorage.getItem(markKey())!)).toMatchObject({ clientRequestId: newer, admitted: true });
  expect(held.size).toBe(0);
});

test('this tab continues its own start; an unknown start can be kept as an unsent draft (never a dead end)', async () => {
  server([start('awaiting-trust')], []);
  write('hello');
  markSentStart(fixture!.runtimeA, directory, request);
  expect(await resolve(request)).toBeNull(); // Its own start: not locked,
  expect(localStorage.getItem(markKey())).not.toBeNull(); // still marked.
  // Another tab, with the start no longer listed: locked as unknown until kept as a draft.
  fixture!.dispose(); fixture = undefined; localStorage.clear(); resetSentStartsForPage(); server([], []);
  await new Promise(done => setTimeout(done, 1)); // That page is gone: so is its lock.
  write('hello');
  markedElsewhere();
  expect(await resolve()).toBe('unknown');
  await keepSentTextAsDraft(fixture!.runtimeA, directory);
  expect(await resolve()).toBeNull();
  expect(readChatDraft(draft()).text).toBe('hello');
});

test('an admitted Send carries the text it submitted, and every tab consumes its own copy of it once', async () => {
  server([], []);
  // The sending tab consumed an older text before; its Send's own submitted text is what it admits.
  write('older message C');
  consumeChatDraft(draft(), 'older message C');
  markSentStart(fixture!.runtimeA, directory, request);
  admitSentStart(fixture!.runtimeA, directory, request, 'same text in both tabs');
  expect(JSON.parse(localStorage.getItem(markKey())!)).toMatchObject({ admitted: true, text: 'same text in both tabs' });
  expect(await resolve()).toBeNull(); // The sending tab itself: handled, so its next draft is never blocked.
  for (let page = 0; page < 2; page++) { // Two other tabs, each with a live copy of that text.
    resetSentStartsForPage();
    const seen: string[] = [];
    const stop = subscribeChatDraftConsumption((identity, submitted) => { if (identity.draftId === draftId) seen.push(submitted); });
    try { expect(await resolve()).toBe('delivered'); expect(await resolve()).toBeNull(); } finally { stop(); }
    expect(seen).toEqual(['same text in both tabs']); // Consumed once per tab; the mark stays for the next tab.
    expect(localStorage.getItem(markKey())).not.toBeNull();
  }
});

// Astra review of #220 (P2): an expired admitted mark is no mark, and an older read never relocks an admitted text.
test('an expired admitted mark never consumes a later draft with the same text', async () => {
  server([], []);
  write('hello'); // A new, unsent prompt that happens to equal the old delivered text.
  localStorage.setItem(markKey(), JSON.stringify({ clientRequestId: request, admitted: true, text: 'hello', at: Date.now() - 700_000 }));
  expect(await resolve()).toBeNull();
  expect(readChatDraft(draft()).text).toBe('hello');
  expect(localStorage.getItem(markKey())).toBeNull();
});

test('admission arriving while an older history read is held: the late empty answer never relocks the composer', async () => {
  let arrive = () => {};
  server([start('ready', true)], [], new Promise<void>(resolve => { arrive = resolve; }));
  write('hello');
  markedElsewhere();
  const older = resolve();
  await new Promise(done => setTimeout(done, 5));
  // Another tab admits this same request: its storage event resolves the updated mark and unlocks.
  markedElsewhere(request, true);
  expect(await resolve()).toBe('delivered');
  write('a new draft typed after admission');
  arrive();
  expect(sentStartLocks(await older)).toBe(false); // Superseded: it reports the current outcome, never 'unknown'.
  expect(readChatDraft(draft()).text).toBe('a new draft typed after admission');
});

// Pre-check round 3: "Edit it as an unsent message" shown before a sender took the request never clears its mark.
test('keeping the text as a draft never clears a mark while a tab is sending that request', async () => {
  server([], []);
  write('hello');
  markedElsewhere();
  held.add(lock()); // Another tab began its Send for this request after this notice showed.
  await keepSentTextAsDraft(fixture!.runtimeA, directory);
  expect(localStorage.getItem(markKey())).toContain(request);
  held.delete(lock());
  await keepSentTextAsDraft(fixture!.runtimeA, directory); // No sender: the person's choice clears it.
  expect(localStorage.getItem(markKey())).toBeNull();
});

test('a stale keep-as-draft click after another tab admitted the request keeps the admitted mark; the text is consumed', async () => {
  server([start('ready', true)], []);
  write('hello');
  markedElsewhere();
  expect(await resolve()).toBe('unknown'); // The notice offers "Edit it as an unsent message".
  markedElsewhere(request, true); // Another tab's Send is admitted and ends; its storage event is not handled yet.
  await keepSentTextAsDraft(fixture!.runtimeA, directory); // The stale click.
  expect(JSON.parse(localStorage.getItem(markKey())!)).toMatchObject({ clientRequestId: request, admitted: true });
  expect(await resolve()).toBe('delivered'); // The storage event: this copy is consumed, never sent again.
  expect(readChatDraft(draft()).text).toBe('');
});
