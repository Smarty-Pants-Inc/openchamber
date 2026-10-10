import { describe, expect, test } from 'bun:test';
import './durableStorage.testing';

// smarty-code#461 / openchamber#433 (design after round 5; cut items in smarty-code#1039): pages share one localStorage;
// each TAB has its own sessionStorage, kept across its reloads. A page is one createTabDrafts instance.
const memory = () => {
  const m = new Map<string, string>(); const writes: string[] = [], removes: string[] = [];
  return { writes, removes, map: m, get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => { removes.push(k); m.delete(k); }, setItem: (k: string, v: string) => { writes.push(k); m.set(k, v); return true; } };
};
const RT = 'rt', DIR = '/p';
// A browser LockManager shared by every page of one origin; a page's locks go when it closes.
type Grant = (lock: { name: string } | null) => Promise<void> | undefined;
const lockManager = () => {
  const held = new Map<string, symbol>();
  return {
    page() {
      const self = Symbol('page');
      return { self, request: (name: string, _options: { mode: 'exclusive'; ifAvailable: true }, grant: Grant) => {
        const free = !held.has(name);
        if (free) held.set(name, self);
        return Promise.resolve().then(() => {
          const holding = grant(free ? { name } : null);
          if (free && !holding) held.delete(name); // The grant was declined: the lock goes back.
        });
      } };
    },
    isHeld: (name: string) => held.has(name),
    close(page: { self: symbol }) { for (const [name, owner] of held) if (owner === page.self) held.delete(name); },
  };
};
/** A duplicated tab (or a window opened by this one): the browser copies its sessionStorage. */
const copySession = (from: ReturnType<typeof memory>) => { const to = memory(); for (const [k, v] of from.map) to.map.set(k, v); return to; };
const slotWithMentions = (text: string, since: number) => ({ text, confirmedMentions: ['a.md'], touchedAt: since + 1, since });
const draft = (text: string, touchedAt: number) => ({ text, confirmedMentions: [], touchedAt });

// This module's page is a duplicated tab: another live page holds the copied id, so ownership resolves asynchronously.
const MOD_RT = 'rt-module', MOD_DIR = '/module', HELD = 'held-by-source-page';
const heldSlot = `openchamber.chatDraftSlot:${JSON.stringify([MOD_RT, MOD_DIR, HELD])}`;
const moduleLocks = lockManager();
void moduleLocks.page().request(`openchamber.chatDraftTab:${HELD}`, { mode: 'exclusive', ifAvailable: true }, () => new Promise(() => {}));
window.sessionStorage.setItem('openchamber.chatDraftTab', JSON.stringify([HELD, ''])); // Published by its native owner.
window.localStorage.setItem(heldSlot, JSON.stringify(slotWithMentions('old copy @a.md', 1)));
const modulePage = moduleLocks.page();
let answerLock = () => {}; const lockAnswered = new Promise<void>(resolve => { answerLock = resolve; });
// The browser answers the lock request later than the page's first reads and writes.
const delayedLocks = { request: (name: string, options: { mode: 'exclusive'; ifAvailable: true }, grant: Grant) =>
  lockAnswered.then(() => modulePage.request(name, options, grant)) };
Object.defineProperty(globalThis.navigator, 'locks', { value: delayedLocks, configurable: true });
const { createTabDrafts, tabDraftsReady, newSessionSlotKey } = await import('./chatDraftTabs');
const persistence = await import('./chatDraftPersistence');

describe('a mounted page whose held writes storage refuses once ownership resolves', () => {
  test('the persistence owner is told, the latest held text is owed (not the older copy), and a newer edit recovers', async () => {
    const p = persistence.createChatDraftIdentity(MOD_RT, MOD_DIR, null)!, backing = window.localStorage, set = backing.setItem;
    expect(persistence.readChatDraft(p).text).toBe('old copy @a.md'); // Shown at once.
    expect(persistence.writeChatDraft(p, 'early', [])).toBeUndefined(); // A lifecycle flush before ownership: held.
    expect(persistence.writeChatDraft(p, 'newer early @a.md', ['a.md'], 5)).toBeUndefined();
    expect(persistence.readChatDraft(p).text).toBe('newer early @a.md');
    expect(persistence.isChatDraftEphemeral()).toBe(false);
    let notified = 0; const stop = persistence.subscribeChatDraftPersistence(() => { notified += 1; });
    backing.setItem = (k, v) => { if (k.startsWith('openchamber.chatDraftSlot:') && !k.includes(HELD)) throw new DOMException('full', 'QuotaExceededError'); set.call(backing, k, v); };
    try {
      answerLock();
      await tabDraftsReady;
      expect(newSessionSlotKey(MOD_RT, MOD_DIR)).not.toBe(heldSlot);
      expect(persistence.isChatDraftEphemeral()).toBe(true);
      expect(notified).toBe(1);
      expect(persistence.readChatDraft(p)).toEqual({ text: 'newer early @a.md', confirmedMentions: new Set(['a.md']) });
      expect(persistence.writeChatDraft(p, 'after ready', [])).toBe(false); // Still refused: the latest text is owed.
      backing.setItem = set;
      expect(persistence.writeChatDraft(p, 'after ready 2', [])).toBe(true);
      expect(persistence.isChatDraftEphemeral()).toBe(false);
      expect(JSON.parse(backing.getItem(newSessionSlotKey(MOD_RT, MOD_DIR))!).text).toBe('after ready 2');
      expect(JSON.parse(backing.getItem(heldSlot)!)).toEqual(slotWithMentions('old copy @a.md', 1)); // Source untouched.
    } finally { backing.setItem = set; stop(); }
  });
});

describe('per-tab New session drafts (#461)', () => {
  test('two tabs on one project each keep their own draft; each reload restores its own (the 3.56 repro)', () => {
    const storage = memory(), sa = memory(), sb = memory();
    createTabDrafts({ storage, session: sa, locks: undefined }).writeSlot(RT, DIR, draft('alpha-461', 1));
    createTabDrafts({ storage, session: sb, locks: undefined }).writeSlot(RT, DIR, draft('beta-461', 2));
    expect(createTabDrafts({ storage, session: sa, locks: undefined }).readSlot(RT, DIR)?.text).toBe('alpha-461'); // A reloads.
    expect(createTabDrafts({ storage, session: sb, locks: undefined }).readSlot(RT, DIR)?.text).toBe('beta-461'); // B reloads.
  });

  test('a reload with the lock free keeps the tab\'s id; a fresh tab gets another id and starts empty', async () => {
    const storage = memory(), sa = memory(), locks = lockManager(), first = locks.page();
    const a = createTabDrafts({ storage, session: sa, locks: first }); await a.ready; a.writeSlot(RT, DIR, draft('alpha', 1));
    const [published, staged] = JSON.parse(sa.map.get('openchamber.chatDraftTab')!);
    expect([a.newSessionSlotKey(RT, DIR).includes(JSON.stringify(published)), staged]).toEqual([true, '']); // A granted id: [id, ''].
    locks.close(first);
    const reload = createTabDrafts({ storage, session: sa, locks: locks.page() }); await reload.ready;
    expect(reload.newSessionSlotKey(RT, DIR)).toBe(a.newSessionSlotKey(RT, DIR));
    expect(reload.readSlot(RT, DIR)?.text).toBe('alpha');
    const fresh = createTabDrafts({ storage, session: memory(), locks: locks.page() });
    expect(fresh.tabId()).not.toBe(a.tabId());
    expect(fresh.readSlot(RT, DIR)).toBeUndefined();
  });

  test('a tab writes and removes only its own slot: clearing its draft leaves another tab\'s', () => {
    const storage = memory(), sa = memory(), sb = memory();
    const a = createTabDrafts({ storage, session: sa, locks: undefined }), b = createTabDrafts({ storage, session: sb, locks: undefined });
    a.writeSlot(RT, DIR, draft('alpha', 1)); b.writeSlot(RT, DIR, draft('beta', 2));
    const mark = storage.writes.length; storage.removes.length = 0;
    a.writeSlot(RT, DIR, draft('alpha 2', 3)); a.writeSlot(RT, DIR, undefined);
    expect([...storage.writes.slice(mark), ...storage.removes].every(k => k === a.newSessionSlotKey(RT, DIR))).toBe(true);
    expect(b.readSlot(RT, DIR)?.text).toBe('beta');
  });

  test('the pre-#461 shared draft is copied once into a tab that has none; stored reports a refused copy', () => {
    const storage = memory();
    const a = createTabDrafts({ storage, session: memory(), locks: undefined });
    expect(a.adoptLegacy(RT, DIR, draft('older', 1))).toEqual({ stored: true });
    expect(a.readSlot(RT, DIR)?.text).toBe('older');
    expect(a.adoptLegacy(RT, DIR, draft('older', 1))).toBe(false); // It has its own now.
    const refusing = { ...memory(), setItem: () => false };
    expect(createTabDrafts({ storage: refusing, session: memory(), locks: undefined }).adoptLegacy(RT, DIR, draft('older', 1))).toEqual({ stored: false });
  });

  test('a duplicated tab copies the source draft, then both pages edit without overwriting each other', async () => {
    const storage = memory(), sa = memory(), locks = lockManager();
    const lockA = locks.page(), a = createTabDrafts({ storage, session: sa, locks: lockA });
    await a.ready;
    a.writeSlot(RT, DIR, slotWithMentions('alpha @a.md', 5));
    const sb = copySession(sa), lockB = locks.page(), b = createTabDrafts({ storage, session: sb, locks: lockB });
    expect(b.readSlot(RT, DIR)?.text).toBe('alpha @a.md'); // Shown at once, before ownership resolves.
    await b.ready;
    expect(b.readSlot(RT, DIR)).toEqual(slotWithMentions('alpha @a.md', 5)); // Text, mentions and since copied.
    b.writeSlot(RT, DIR, draft('beta', 9));
    a.writeSlot(RT, DIR, slotWithMentions('alpha 2 @a.md', 10));
    expect(a.readSlot(RT, DIR)?.text).toBe('alpha 2 @a.md');
    expect(b.readSlot(RT, DIR)?.text).toBe('beta');
    // Each tab's reload restores its own draft.
    locks.close(lockA); locks.close(lockB);
    const ra = createTabDrafts({ storage, session: sa, locks: locks.page() }), rb = createTabDrafts({ storage, session: sb, locks: locks.page() });
    await Promise.all([ra.ready, rb.ready]);
    expect(ra.readSlot(RT, DIR)?.text).toBe('alpha 2 @a.md');
    expect(rb.readSlot(RT, DIR)?.text).toBe('beta');
    expect(storage.removes).toEqual([]);
  });

  test('two copies opened at once: exactly one keeps the id, the other copies; the source slot is never moved', async () => {
    const storage = memory(), source = memory(), locks = lockManager();
    const owner = locks.page(), s = createTabDrafts({ storage, session: source, locks: owner }); await s.ready;
    s.writeSlot(RT, DIR, slotWithMentions('src @a.md', 3)); locks.close(owner); // The source page went; its id is free.
    const key = s.newSessionSlotKey(RT, DIR), kept = storage.getItem(key);
    const pages = [copySession(source), copySession(source)].map(session => createTabDrafts({ storage, session, locks: locks.page() }));
    await Promise.all(pages.map(p => p.ready));
    const keys = pages.map(p => p.newSessionSlotKey(RT, DIR));
    expect(keys.filter(k => k === key)).toHaveLength(1);
    expect(new Set(keys).size).toBe(2);
    pages.forEach((p, i) => p.writeSlot(RT, DIR, draft(`page ${i}`, 10 + i)));
    expect(pages.map(p => p.readSlot(RT, DIR)?.text)).toEqual(['page 0', 'page 1']);
    // The copy that forked left the source's bytes alone until the owner itself wrote.
    const forked = pages.find(p => p.newSessionSlotKey(RT, DIR) !== key)!;
    expect(forked.tabId()).toBe(s.tabId()); // Page-local identity keys stay the same across the fork.
    expect(storage.removes).toEqual([]);
    expect(kept).toContain('src @a.md');
  });

  test('writes before the lock answers are held, never written to the shared candidate, then land in the owned slot', async () => {
    const storage = memory(), sa = memory(), locks = lockManager();
    const a = createTabDrafts({ storage, session: sa, locks: locks.page() }); await a.ready;
    a.writeSlot(RT, DIR, draft('source', 1));
    const candidate = a.newSessionSlotKey(RT, DIR), before = storage.getItem(candidate);
    const b = createTabDrafts({ storage, session: copySession(sa), locks: locks.page() });
    expect(b.writeSlot(RT, DIR, draft('typed early', 2))).toBeUndefined(); // Not saved yet, not refused either.
    expect(b.readSlot(RT, DIR)?.text).toBe('typed early'); // Live input stays.
    expect(b.owes(RT, DIR)).toBe(true);
    expect(b.writeSlot(RT, DIR, undefined)).toBeUndefined(); // A send/clear while held: the latest wins.
    expect(b.readSlot(RT, DIR)).toBeUndefined();
    expect(storage.getItem(candidate)).toBe(before);
    await b.ready;
    expect(b.newSessionSlotKey(RT, DIR)).not.toBe(candidate);
    expect(JSON.parse(storage.getItem(b.newSessionSlotKey(RT, DIR))!).text).toBe(''); // The clear beat the copy.
    expect(b.owes(RT, DIR)).toBe(false);
    b.writeSlot(RT, DIR, draft('newer edit', 3));
    expect([a.readSlot(RT, DIR)?.text, b.readSlot(RT, DIR)?.text]).toEqual(['source', 'newer edit']);
    expect(storage.getItem(candidate)).toBe(before);
  });

  test('the owner of the id writes its own slot after the lock answers; a reload with the lock free keeps the id', async () => {
    const storage = memory(), sa = memory(), locks = lockManager();
    const first = locks.page(), a = createTabDrafts({ storage, session: sa, locks: first }); await a.ready;
    a.writeSlot(RT, DIR, draft('kept', 1));
    locks.close(first);
    const reload = createTabDrafts({ storage, session: sa, locks: locks.page() });
    reload.writeSlot(RT, DIR, draft('after reload', 2));
    expect(storage.getItem(a.newSessionSlotKey(RT, DIR))).toContain('"kept"'); // Held until ownership is known.
    await reload.ready;
    expect(reload.newSessionSlotKey(RT, DIR)).toBe(a.newSessionSlotKey(RT, DIR));
    expect(storage.getItem(a.newSessionSlotKey(RT, DIR))).toContain('after reload');
  });

  test('without Web Locks a copied tab is isolated at once: it copies the source and never writes its slot', () => {
    const storage = memory(), sa = memory();
    const a = createTabDrafts({ storage, session: sa, locks: undefined }); a.writeSlot(RT, DIR, slotWithMentions('src @a.md', 4));
    const b = createTabDrafts({ storage, session: copySession(sa), locks: undefined });
    expect(b.readSlot(RT, DIR)).toEqual(slotWithMentions('src @a.md', 4));
    b.writeSlot(RT, DIR, undefined); // A send in the copy.
    expect(a.readSlot(RT, DIR)?.text).toBe('src @a.md');
    expect(b.readSlot(RT, DIR)).toBeUndefined();
    const failing = { request: () => { throw new Error('denied'); } };
    const c = createTabDrafts({ storage, session: copySession(sa), locks: failing });
    return c.ready.then(() => expect(c.newSessionSlotKey(RT, DIR)).not.toBe(a.newSessionSlotKey(RT, DIR)));
  });

  test('a refused copy or held write stays owed and retries; the source keeps its draft', async () => {
    const backing = memory(); let refuse = true;
    const storage = { ...backing, get length() { return backing.map.size; }, key: backing.key, getItem: backing.getItem,
      setItem: (k: string, v: string) => (refuse && !k.includes('"src"') ? false : backing.setItem(k, v)) };
    const source = memory(); source.map.set('openchamber.chatDraftTab', JSON.stringify(['src', ''])); // Natively granted.
    const locks = lockManager(), holder = locks.page();
    const owner = createTabDrafts({ storage, session: source, locks: holder }); await owner.ready;
    owner.writeSlot(RT, DIR, draft('source text', 1));
    const copy = createTabDrafts({ storage, session: copySession(source), locks: locks.page() }); await copy.ready;
    expect(copy.hasUnsaved()).toBe(true); // The copy into its new id was refused, so it is owed.
    expect(copy.readSlot(RT, DIR)?.text).toBe('source text');
    expect(copy.writeSlot(RT, DIR, draft('edited', 2))).toBe(false);
    refuse = false;
    expect(copy.retryUnsaved()).toEqual([JSON.stringify([RT, DIR, null])]);
    expect(copy.hasUnsaved()).toBe(false);
    expect([owner.readSlot(RT, DIR)?.text, copy.readSlot(RT, DIR)?.text]).toEqual(['source text', 'edited']);
  });

  // The browser may answer a page's first lock request after a copy of the page claimed: no id is writable before its grant.
  const gatedPage = (locks: ReturnType<typeof lockManager>) => {
    const page = locks.page(); let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
    return { release, locks: { request: (name: string, options: { mode: 'exclusive'; ifAvailable: true }, grant: Grant) =>
      gate.then(() => page.request(name, options, grant)) }, page };
  };
  const beta = { text: 'beta @b.md', confirmedMentions: ['b.md'], touchedAt: 16, since: 15 };
  const alpha2 = { text: 'alpha 2 @c.md', confirmedMentions: ['c.md'], touchedAt: 26, since: 25 };
  for (const suspendFirst of [false, true]) test(`a copy made before a fresh page's first grant keeps its own draft${suspendFirst ? ' (pagehide first)' : ''}`, async () => {
    const storage = memory(), sa = memory(), locks = lockManager(), original = gatedPage(locks);
    const a = createTabDrafts({ storage, session: sa, locks: original.locks });
    expect(a.writeSlot(RT, DIR, slotWithMentions('alpha @a.md', 5))).toBeUndefined(); // Held: not yet owned.
    if (suspendFirst) a.suspend(); // Durable now, in a staged copy no other page writes.
    const staged = new Set(storage.map.keys());
    const sb = copySession(sa), lockB = locks.page(), b = createTabDrafts({ storage, session: sb, locks: lockB });
    await b.ready; // The copy claims first.
    const bWrites = storage.writes.length;
    b.writeSlot(RT, DIR, beta);
    expect(storage.writes.slice(bWrites).some(k => staged.has(k))).toBe(false);
    expect(a.writeSlot(RT, DIR, alpha2)).toBe(suspendFirst ? true : undefined);
    original.release(); await a.ready;
    expect(a.newSessionSlotKey(RT, DIR)).not.toBe(b.newSessionSlotKey(RT, DIR));
    expect([a.readSlot(RT, DIR), b.readSlot(RT, DIR)]).toEqual([alpha2, beta]);
    expect(JSON.parse(storage.getItem(a.newSessionSlotKey(RT, DIR))!)).toEqual(alpha2);
    expect(JSON.parse(storage.getItem(b.newSessionSlotKey(RT, DIR))!)).toEqual(beta);
    a.writeSlot(RT, DIR, undefined); // A send in the original never clears the copy.
    expect(b.readSlot(RT, DIR)).toEqual(beta);
    locks.close(original.page); locks.close(lockB);
    const ra = createTabDrafts({ storage, session: sa, locks: locks.page() }), rb = createTabDrafts({ storage, session: sb, locks: locks.page() });
    await Promise.all([ra.ready, rb.ready]);
    expect([ra.readSlot(RT, DIR), rb.readSlot(RT, DIR)]).toEqual([undefined, beta]);
    expect(storage.removes).toEqual([]);
  });

  test('a page stopping before its grant stages its writes durably; the grant then places the newest, never older', async () => {
    const storage = memory(), sa = memory(), locks = lockManager(), first = locks.page();
    const a = createTabDrafts({ storage, session: sa, locks: first }); await a.ready;
    a.writeSlot(RT, DIR, slotWithMentions('source @a.md', 1));
    const candidate = a.newSessionSlotKey(RT, DIR), before = storage.getItem(candidate);
    locks.close(first); // The source page went: the grant will come, but late.
    const sb = copySession(sa), late = gatedPage(locks), b = createTabDrafts({ storage, session: sb, locks: late.locks });
    expect(b.writeSlot(RT, DIR, draft('typed', 2))).toBeUndefined();
    b.suspend();
    expect(b.writeSlot(RT, DIR, draft('lifecycle save', 3))).toBe(true); // Durable in the staged copy.
    expect(storage.getItem(candidate)).toBe(before);
    // Unloaded before the grant: the reload finds the staged copy (never claims it) and keeps the newest text.
    const reload = createTabDrafts({ storage, session: copySession(sb), locks: locks.page() }); await reload.ready;
    expect(reload.readSlot(RT, DIR)?.text).toBe('lifecycle save');
    // Or resumed: the late grant places the newest held write, not the older staged one.
    b.writeSlot(RT, DIR, draft('newer edit', 4));
    late.release(); await b.ready;
    expect(b.readSlot(RT, DIR)?.text).toBe('newer edit');
    expect(JSON.parse(storage.getItem(b.newSessionSlotKey(RT, DIR))!).text).toBe('newer edit');
    expect(b.newSessionSlotKey(RT, DIR)).not.toBe(reload.newSessionSlotKey(RT, DIR));
  });

  // openchamber#433 migration: a pre-tuple page published a plain id and held no native lock for it. Such an id is a
  // copy-only source even when its lock is free: the live legacy page still writes that slot.
  test('a legacy #433 plain id is copy-only even with its lock free: the live legacy page keeps its slot', async () => {
    const storage = memory(), sa = memory(), locks = lockManager(), LEGACY = 'legacy-433';
    const legacyKey = `openchamber.chatDraftSlot:${JSON.stringify([RT, DIR, LEGACY])}`;
    sa.map.set('openchamber.chatDraftTab', LEGACY); // The legacy live page: plain id, no native lock.
    storage.setItem(legacyKey, JSON.stringify(draft('legacy text', 1)));
    const mark = storage.writes.length;
    const opener = createTabDrafts({ storage, session: copySession(sa), locks: locks.page() });
    expect(opener.readSlot(RT, DIR)?.text).toBe('legacy text'); // Reads the source at once.
    await opener.ready;
    expect(locks.isHeld(`openchamber.chatDraftTab:${LEGACY}`)).toBe(false); // Never claimed.
    expect(opener.newSessionSlotKey(RT, DIR)).not.toBe(legacyKey);
    expect(opener.readSlot(RT, DIR)?.text).toBe('legacy text'); // Copied.
    opener.writeSlot(RT, DIR, draft('opener edit', 2));
    expect(storage.writes.slice(mark)).not.toContain(legacyKey);
    storage.setItem(legacyKey, JSON.stringify(draft('legacy newer', 3))); // The legacy page saves after the opener.
    opener.writeSlot(RT, DIR, draft('opener edit 2', 4));
    expect(JSON.parse(storage.getItem(legacyKey)!).text).toBe('legacy newer');
    expect(opener.readSlot(RT, DIR)?.text).toBe('opener edit 2');
    expect(storage.removes).toEqual([]);
  });

  test('a staged record never claims its published id: the id owner\'s newer retained draft survives a copy', async () => {
    const storage = memory(), sa = memory(), locks = lockManager(), first = locks.page();
    const a = createTabDrafts({ storage, session: sa, locks: first }); await a.ready;
    a.writeSlot(RT, DIR, draft('old', 1));
    const candidate = a.newSessionSlotKey(RT, DIR);
    const sb = copySession(sa), b = createTabDrafts({ storage, session: sb, locks: gatedPage(locks).locks });
    b.suspend(); // Staged copy of 'old', recorded beside the published id.
    a.writeSlot(RT, DIR, draft('newer', 2)); locks.close(first); // The id's owner saves newer text and goes.
    const c = createTabDrafts({ storage, session: copySession(sb), locks: locks.page() }); await c.ready;
    expect(c.newSessionSlotKey(RT, DIR)).not.toBe(candidate);
    expect(c.readSlot(RT, DIR)?.text).toBe('old');
    c.writeSlot(RT, DIR, draft('c edit', 3));
    expect(JSON.parse(storage.getItem(candidate)!).text).toBe('newer');
  });

  for (const inherit of [false, true]) test(`failing Web Locks write an unlocked id an opener with working locks only copies${inherit ? ' (inherited)' : ''}`, async () => {
    const storage = memory(), locks = lockManager(), failing = { request: () => Promise.reject(new Error('denied')) };
    let session = memory();
    if (inherit) { const a = createTabDrafts({ storage, session, locks: locks.page() }); await a.ready; a.writeSlot(RT, DIR, draft('source', 1)); session = copySession(session); }
    const f = createTabDrafts({ storage, session, locks: failing }); await f.ready;
    f.writeSlot(RT, DIR, slotWithMentions('f @a.md', 5));
    const g = createTabDrafts({ storage, session: copySession(session), locks: locks.page() }); await g.ready;
    expect(g.newSessionSlotKey(RT, DIR)).not.toBe(f.newSessionSlotKey(RT, DIR));
    expect(g.readSlot(RT, DIR)).toEqual(slotWithMentions('f @a.md', 5));
    g.writeSlot(RT, DIR, beta); f.writeSlot(RT, DIR, alpha2);
    expect([f.readSlot(RT, DIR), g.readSlot(RT, DIR)]).toEqual([alpha2, beta]);
    const reload = createTabDrafts({ storage, session, locks: locks.page() }); await reload.ready; // f reloaded: a copy, kept.
    expect(reload.readSlot(RT, DIR)).toEqual(alpha2);
    expect(reload.newSessionSlotKey(RT, DIR)).not.toBe(f.newSessionSlotKey(RT, DIR));
  });

  test('a refused staged write at suspend stays owed in the staged copy, never the candidate', () => {
    const backing = memory(); let refuse = true;
    const storage = { ...backing, get length() { return backing.map.size; }, key: backing.key, getItem: backing.getItem,
      setItem: (k: string, v: string) => (refuse && !k.includes('"src"') ? false : backing.setItem(k, v)) };
    const sa = memory(); sa.map.set('openchamber.chatDraftTab', JSON.stringify(['src', '']));
    backing.setItem(`openchamber.chatDraftSlot:${JSON.stringify([RT, DIR, 'src'])}`, JSON.stringify(draft('source', 1)));
    const b = createTabDrafts({ storage, session: sa, locks: lockManager().page() });
    b.writeSlot(RT, DIR, draft('typed', 2)); b.suspend();
    expect(b.hasUnsaved()).toBe(true);
    refuse = false; b.retryUnsaved();
    expect(b.hasUnsaved()).toBe(false);
    expect(b.readSlot(RT, DIR)?.text).toBe('typed');
    expect(JSON.parse(backing.getItem(`openchamber.chatDraftSlot:${JSON.stringify([RT, DIR, 'src'])}`)!).text).toBe('source');
  });

  test('a durable clear survives a copy: a reload into a new id cannot re-adopt the shared legacy draft', () => {
    const storage = memory(), sa = memory(), legacy = draft('delivered legacy', 1);
    const a = createTabDrafts({ storage, session: sa, locks: undefined });
    expect(a.adoptLegacy(RT, DIR, legacy)).toEqual({ stored: true });
    a.writeSlot(RT, DIR, undefined); // Sent; the envelope's legacy cleanup is still owed (refused elsewhere).
    const source = a.newSessionSlotKey(RT, DIR), cleared = storage.getItem(source);
    const reload = createTabDrafts({ storage, session: sa, locks: undefined }); // No Web Locks: a new id.
    expect(reload.newSessionSlotKey(RT, DIR)).not.toBe(source);
    expect(reload.adoptLegacy(RT, DIR, legacy)).toBe(false); // The copied empty slot supersedes the shared text.
    expect(reload.readSlot(RT, DIR)).toBeUndefined();
    expect(storage.getItem(source)).toBe(cleared); // Source retained.
  });

  // SCOPE DECISION on openchamber#433 (5911825844), condition (a): no closed tab's draft is destroyed; smarty-code#1039
  // recovers it later. Nothing here removes or overwrites another tab's slot, whatever the other tabs do.
  test('a closed tab\'s slot stays in storage while other tabs save, clear and migrate the shared draft', () => {
    const storage = memory();
    const closed = createTabDrafts({ storage, session: memory(), locks: undefined }); closed.writeSlot(RT, DIR, draft('unsent in a closed tab', 1));
    const key = closed.newSessionSlotKey(RT, DIR), kept = storage.getItem(key);
    for (let k = 0; k < 20; k++) {
      const other = createTabDrafts({ storage, session: memory(), locks: undefined });
      other.adoptLegacy(RT, DIR, draft('shared', 0)); other.writeSlot(RT, DIR, draft(`other ${k}`, 2 + k)); other.writeSlot(RT, DIR, undefined);
    }
    expect(storage.getItem(key)).toBe(kept);
    expect(storage.removes).toEqual([]);
  });
});
