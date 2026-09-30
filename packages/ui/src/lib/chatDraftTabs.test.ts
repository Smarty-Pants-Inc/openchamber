import { describe, expect, test } from 'bun:test';
import { ADOPTED_KEEP_MS, createTabDrafts } from './chatDraftTabs';

// openchamber#433 review 2 (5905489097): two or more PAGES share one localStorage; each page has its own
// sessionStorage (a copy, for a duplicated tab), window events and Web Locks. Each regression below is one finding.
const memory = () => {
  const m = new Map<string, string>(); let refuse: ((key: string) => boolean) | undefined, after: ((key: string) => void) | undefined;
  return { refuse: (f?: (key: string) => boolean) => { refuse = f; }, afterSet: (f?: (key: string) => void) => { after = f; },
    getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { if (refuse?.(k)) return false; m.set(k, v); const f = after; after = undefined; f?.(k); return true; },
    key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; }, map: m };
};
const events = () => {
  const on: Record<string, ((e: unknown) => void)[]> = {};
  return { addEventListener: (t: string, f: (e: unknown) => void) => { (on[t] ??= []).push(f); },
    fire: (t: string, e: unknown = {}) => (on[t] ?? []).forEach(f => f(e)), on };
};
/** Web Locks shared by the pages: a name is held until its page closes; `ifAvailable` answers null when held. */
const lockManager = () => {
  const held = new Map<string, string>(), gates: (() => void)[] = [];
  let hold = false;
  return { held, gate: (on: boolean) => { hold = on; if (!on) gates.splice(0).forEach(g => g()); },
    close: (pageName: string) => { for (const [n, p] of held) if (p === pageName) held.delete(n); },
    for: (pageName: string) => ({ request: async (name: string, _o: { ifAvailable: boolean }, cb: (l: unknown) => unknown) => {
      if (hold) await new Promise<void>(r => gates.push(r));
      if (held.has(name)) { await cb(null); return; }
      held.set(name, pageName); void cb({ name });
    } }) };
};
const tick = () => new Promise(r => setTimeout(r, 0));
const RT = 'rt', DIR = '/p';
const slot = (text: string, touchedAt = 1) => ({ text, confirmedMentions: [], touchedAt });

describe('per-tab New session drafts (#461, openchamber#433 r2)', () => {
  test('P1 1: the unload flush after the claim release does not re-claim; a fresh tab recovers the closed tab\'s draft; a reload keeps its id', () => {
    const storage = memory(), session = memory(), win = events();
    const a = createTabDrafts({ storage, session, window: win });
    a.writeSlot(RT, DIR, slot('alpha'));
    const id = a.tabId();
    // Real unload order: the claim listener (registered first) runs, then the composer's flush reads the draft again.
    win.fire('pagehide'); a.tabId(); a.writeSlot(RT, DIR, slot('alpha'));
    expect(storage.getItem(`openchamber.chatDraftTabClaim:${id}`)).toBeNull();
    const c = createTabDrafts({ storage, session: memory(), window: events() }); // A fresh tab.
    expect(c.adoptOrphan(RT, DIR)).toMatchObject({ from: 'orphan', stored: true });
    expect(c.readSlot(RT, DIR)?.text).toBe('alpha');
    const reloaded = createTabDrafts({ storage, session, window: events() }); // A's reload: the same sessionStorage.
    expect(reloaded.tabId()).toBe(id);
  });

  test('P1 2: two pages that load the same copied id at once: the lock keeps one; the other moves before it saves anything', async () => {
    const storage = memory(), locks = lockManager();
    locks.gate(true); // Both ask for the lock before either answer arrives.
    const sa = memory(), sb = memory(); sa.setItem('openchamber.chatDraftTab', 'copied-id'); sb.setItem('openchamber.chatDraftTab', 'copied-id');
    const pa = createTabDrafts({ storage, session: sa, locks: locks.for('A') }), pb = createTabDrafts({ storage, session: sb, locks: locks.for('B') });
    expect(pa.tabId()).toBe('copied-id'); expect(pb.tabId()).toBe('copied-id');
    pa.writeSlot(RT, DIR, slot('alpha')); pb.writeSlot(RT, DIR, slot('beta')); // Both save while the lock is undecided.
    locks.gate(false); await tick(); await tick();
    expect(new Set([pa.tabId(), pb.tabId()]).size).toBe(2);
    expect(pa.readSlot(RT, DIR)?.text).toBe('alpha');
    expect(pb.readSlot(RT, DIR)?.text).toBe('beta');
    // A reloads into its own text, not B's.
    const again = createTabDrafts({ storage, session: sa, locks: locks.for('A2') }); locks.close('A');
    expect(again.readSlot(RT, DIR)?.text).toBe('alpha');
  });

  test('P1 2 (no Web Locks): a conflicting claim found after start moves this page; the other keeps its text', () => {
    const storage = memory(), sa = memory(), sb = memory();
    sa.setItem('openchamber.chatDraftTab', 'copied-id'); sb.setItem('openchamber.chatDraftTab', 'copied-id');
    const a = createTabDrafts({ storage, session: sa }), b = createTabDrafts({ storage, session: sb });
    // Interleaved start: both read an absent claim before either wrote it (B's read is replayed by removing A's claim
    // first); B's claim is the last write.
    expect(a.tabId()).toBe('copied-id'); storage.removeItem('openchamber.chatDraftTabClaim:copied-id');
    expect(b.tabId()).toBe('copied-id');
    b.writeSlot(RT, DIR, slot('beta'));
    a.writeSlot(RT, DIR, slot('alpha')); // A finds B's claim: A moves, and its save goes to its new id.
    expect(a.tabId()).not.toBe('copied-id');
    expect(b.readSlot(RT, DIR)?.text).toBe('beta');
    expect(a.readSlot(RT, DIR)?.text).toBe('alpha');
  });

  test('P1 3: an adopter never writes the original\'s slot: a tab returning from the back/forward cache keeps its newer draft', () => {
    const storage = memory(), winA = events(), sa = memory();
    const a = createTabDrafts({ storage, session: sa, window: winA });
    a.writeSlot(RT, DIR, slot('alpha', 1)); winA.fire('pagehide');
    const b = createTabDrafts({ storage, session: memory() });
    b.tabId();
    // B has read A's released slot and stores its copy; right then A returns from the cache and saves gamma. Whatever B
    // does next must not write A's slot.
    storage.afterSet(() => { winA.fire('pageshow', { persisted: true }); a.writeSlot(RT, DIR, slot('gamma', 2)); });
    expect(b.adoptOrphan(RT, DIR)).toMatchObject({ from: 'orphan' });
    expect(b.readSlot(RT, DIR)?.text).toBe('alpha');
    expect(a.readSlot(RT, DIR)?.text).toBe('gamma');
  });

  test('P1 3: pruning never removes an original whose tab is open again, or that changed since it was copied', () => {
    let now = 1_000; const storage = memory(), winA = events(), sa = memory();
    const a = createTabDrafts({ storage, session: sa, window: winA, now: () => now });
    a.writeSlot(RT, DIR, slot('alpha', 1)); winA.fire('pagehide');
    const b = createTabDrafts({ storage, session: memory(), now: () => now });
    expect(b.adoptOrphan(RT, DIR)).toMatchObject({ from: 'orphan' });
    winA.fire('pageshow', { persisted: true }); // A's tab is open again.
    now += ADOPTED_KEEP_MS + 1;
    b.writeSlot(RT, DIR, undefined); b.adoptOrphan(RT, DIR); // B cleared its copy; a later read prunes.
    expect(a.readSlot(RT, DIR)?.text).toBe('alpha');
    // Closed again but changed since the copy: kept too.
    a.writeSlot(RT, DIR, slot('alpha edited', 5)); winA.fire('pagehide');
    createTabDrafts({ storage, session: memory(), now: () => now }).adoptOrphan(RT, DIR);
    expect(storage.getItem(a.newSessionSlotKey(RT, DIR)) ?? '').toContain('alpha edited');
  });

  test('P1 4: a refused copy is not committed: no marker, the original stays, and the failure is reported', () => {
    const storage = memory(), winA = events();
    const a = createTabDrafts({ storage, session: memory(), window: winA });
    a.writeSlot(RT, DIR, slot('alpha')); winA.fire('pagehide');
    const b = createTabDrafts({ storage, session: memory() });
    storage.refuse(k => k.startsWith('openchamber.chatDraftSlot:') && k.includes(b.tabId()));
    expect(b.adoptOrphan(RT, DIR)).toMatchObject({ from: 'orphan', stored: false });
    expect([...storage.map.keys()].some(k => k.startsWith('openchamber.chatDraftAdopted:'))).toBe(false);
    expect(storage.getItem(a.newSessionSlotKey(RT, DIR))).toContain('alpha');
    storage.refuse();
    expect(b.adoptOrphan(RT, DIR)).toMatchObject({ from: 'orphan', stored: true }); // The next read copies it.
  });
});
