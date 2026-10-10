import { expect, test } from 'bun:test';
import { z } from 'zod';
import './durableStorage.testing';

// A fresh tab reads shared (pre-#461) legacy drafts before its Web Lock is granted: the copies are held in memory, so
// nothing may retire the shared entries yet. Once the grant places those copies durably, each durably placed copy must
// retire its shared entry; a refused placement keeps the entry until a later durable retry stores the copy.
const RT = 'deferred-legacy-rt';
const ENVELOPE = 'openchamber.chatDrafts.v2';
const legacyKey = (directory: string) => JSON.stringify([RT, directory, null]);
const sessionKey = (directory: string, sessionId: string) => JSON.stringify([RT, directory, sessionId]);
const entry = (text: string, touchedAt: number) => ({ text, confirmedMentions: [], touchedAt, since: touchedAt });

// Case 1: two distinct projects read before the grant, both placed durably.
const A = '/deferred-a', B = '/deferred-b';
// Case 2: one project whose placement storage refuses once, and a sibling placed durably in the same grant.
const R = '/deferred-refused', OK = '/deferred-sibling';
// Counterexamples: a session draft and a project this page never reads keep their envelope entries.
const UNREAD = '/deferred-unread', SESSION = { directory: A, sessionId: 'S-kept' };

const backing = window.localStorage;
backing.setItem(ENVELOPE, JSON.stringify({ version: 2, drafts: {
  [legacyKey(A)]: entry('legacy A', 10),
  [legacyKey(B)]: entry('legacy B', 11),
  [legacyKey(R)]: entry('legacy R', 12),
  [legacyKey(OK)]: entry('legacy OK', 13),
  [legacyKey(UNREAD)]: entry('legacy unread', 14),
  [sessionKey(SESSION.directory, SESSION.sessionId)]: entry('session kept', 15),
} }));

// The browser answers this page's lock request only when a test releases it, after the reads below.
let grantLock = () => {};
const lockGate = new Promise<void>(resolve => { grantLock = resolve; });
const gatedLocks = { request: (name: string, _options: { mode: 'exclusive'; ifAvailable: true },
  grant: (lock: { name: string } | null) => Promise<void> | undefined) => lockGate.then(() => grant({ name })) };
Object.defineProperty(globalThis.navigator, 'locks', { value: gatedLocks, configurable: true });

const { createTabDrafts, newSessionSlotKey, tabDraftsReady } = await import('./chatDraftTabs');
const persistence = await import('./chatDraftPersistence');
const identity = (directory: string, sessionId: string | null = null) => persistence.createChatDraftIdentity(RT, directory, sessionId)!;

const envelopeSchema = z.object({ version: z.literal(2), drafts: z.record(z.string(), z.object({ text: z.string() })) });
/** The durable shared envelope's drafts, read from the native storage (not the safe adapter's page memory). */
const durableEnvelope = () => envelopeSchema.parse(JSON.parse(backing.getItem(ENVELOPE) ?? '')).drafts;
const durableSlotText = (directory: string) => {
  const raw = backing.getItem(newSessionSlotKey(RT, directory));
  return raw === null ? undefined : z.object({ text: z.string() }).parse(JSON.parse(raw)).text;
};
/** A later fresh tab (no tab record, no Web Locks) offered the project's current shared entry. */
const freshTabAdopts = (directory: string) => {
  const session = new Map<string, string>();
  const fresh = createTabDrafts({ storage: backing, session: {
    getItem: key => session.get(key) ?? null, setItem: (key, value) => { session.set(key, value); } }, locks: undefined });
  const legacy = durableEnvelope()[legacyKey(directory)];
  const adopted = fresh.adoptLegacy(RT, directory, legacy === undefined ? undefined : { ...legacy, confirmedMentions: [], touchedAt: 1 });
  return { adopted, text: fresh.readSlot(RT, directory)?.text };
};

// Storage refuses R's first deferred placement on the native method; the key is the id the grant settles.
const refusedSlot = newSessionSlotKey(RT, R), nativeSet = backing.setItem;
let refusals = 0;
const migrationEvents: { kind: 'refused' | 'retried' | 'removed'; legacyPresent: boolean; slotStored: boolean }[] = [];
backing.setItem = (key, value) => {
  if (key === refusedSlot) {
    const legacyPresent = durableEnvelope()[legacyKey(R)]?.text === 'legacy R';
    if (refusals === 0) {
      refusals += 1;
      migrationEvents.push({ kind: 'refused', legacyPresent, slotStored: backing.getItem(key) !== null });
      throw new DOMException('refused placement', 'QuotaExceededError');
    }
    migrationEvents.push({ kind: 'retried', legacyPresent, slotStored: backing.getItem(key) !== null });
  }
  if (key === ENVELOPE && envelopeSchema.parse(JSON.parse(value)).drafts[legacyKey(R)] === undefined) {
    migrationEvents.push({ kind: 'removed', legacyPresent: false, slotStored: durableSlotText(R) === 'legacy R' });
  }
  nativeSet.call(backing, key, value);
};

// Every read happens before the one grant both cases share.
const beforeGrant = {
  shown: Object.fromEntries([A, B, R, OK].map(directory => [directory, persistence.readChatDraft(identity(directory)).text])),
  envelope: durableEnvelope(),
  ephemeral: persistence.isChatDraftEphemeral(),
};
// New input and a consumed/cleared draft must keep the migration marker when they replace a held copy.
const heldUpdates = [persistence.writeChatDraft(identity(A), 'edited A', []), persistence.writeChatDraft(identity(B), '', [])];
let granted: Promise<void> | undefined;
const grantAndSettle = () => granted ??= (async () => {
  grantLock();
  await tabDraftsReady;
  await new Promise(resolve => setTimeout(resolve, 0)); // Let the persistence owner's ready continuation run.
})();

test('a deferred legacy copy placed durably at the grant retires its shared entry; a fresh tab cannot adopt it again', async () => {
  expect(beforeGrant.shown[A]).toBe('legacy A');
  expect(beforeGrant.shown[B]).toBe('legacy B');
  // Held in memory only: the shared entries must survive until the grant places the copies.
  expect(beforeGrant.envelope[legacyKey(A)]?.text).toBe('legacy A');
  expect(beforeGrant.envelope[legacyKey(B)]?.text).toBe('legacy B');
  expect(beforeGrant.ephemeral).toBe(false);
  expect(heldUpdates).toEqual([undefined, undefined]);

  await grantAndSettle();

  expect(durableSlotText(A)).toBe('edited A');
  expect(durableSlotText(B)).toBe('');
  const envelope = durableEnvelope();
  expect(envelope[legacyKey(A)]).toBeUndefined();
  expect(envelope[legacyKey(B)]).toBeUndefined();
  // Counterexamples: a session draft and an unread project's shared draft stay.
  expect(envelope[sessionKey(SESSION.directory, SESSION.sessionId)]?.text).toBe('session kept');
  expect(envelope[legacyKey(UNREAD)]?.text).toBe('legacy unread');
  expect(freshTabAdopts(A)).toEqual({ adopted: false, text: undefined });
  expect(freshTabAdopts(B)).toEqual({ adopted: false, text: undefined });
  expect(persistence.readChatDraft(identity(A)).text).toBe('edited A');
  expect(persistence.readChatDraft(identity(B)).text).toBe('');
  expect(persistence.readChatDraft(identity(A, SESSION.sessionId)).text).toBe('session kept');
});

test('a refused deferred placement keeps its shared entry until a durable retry, while its placed sibling retires', async () => {
  expect(beforeGrant.shown[R]).toBe('legacy R');
  expect(beforeGrant.shown[OK]).toBe('legacy OK');
  expect(beforeGrant.envelope[legacyKey(R)]?.text).toBe('legacy R');
  expect(beforeGrant.envelope[legacyKey(OK)]?.text).toBe('legacy OK');

  await grantAndSettle();

  expect(refusals).toBe(1);
  expect(durableSlotText(OK)).toBe('legacy OK');
  expect(durableEnvelope()[legacyKey(OK)]).toBeUndefined();
  expect(persistence.readChatDraft(identity(R)).text).toBe('legacy R');

  // Finishing a durable sibling also retries owed slots. The shared R entry must still exist when its retry begins,
  // and every envelope cleanup must follow its durable copy, never the refused placement.
  expect(migrationEvents[0]).toEqual({ kind: 'refused', legacyPresent: true, slotStored: false });
  expect(migrationEvents[1]).toEqual({ kind: 'retried', legacyPresent: true, slotStored: false });
  expect(migrationEvents.filter(event => event.kind === 'removed').length).toBeGreaterThan(0);
  expect(migrationEvents.filter(event => event.kind === 'removed').every(event => event.slotStored)).toBe(true);

  // A later session-envelope save preserves the completed migration.
  const retrySession = identity(R, 'S-retry');
  expect(persistence.writeChatDraft(retrySession, 'session retry', [], 20)).toBe(true);
  expect(durableSlotText(R)).toBe('legacy R');
  const afterRetry = durableEnvelope();
  expect(afterRetry[legacyKey(R)]).toBeUndefined();
  expect(persistence.isChatDraftEphemeral()).toBe(false);
  expect(freshTabAdopts(R)).toEqual({ adopted: false, text: undefined });
  // Counterexamples: the session drafts and the unread project's shared draft stay.
  expect(afterRetry[sessionKey(R, 'S-retry')]?.text).toBe('session retry');
  expect(afterRetry[sessionKey(SESSION.directory, SESSION.sessionId)]?.text).toBe('session kept');
  expect(afterRetry[legacyKey(UNREAD)]?.text).toBe('legacy unread');
  backing.setItem = nativeSet;
});
