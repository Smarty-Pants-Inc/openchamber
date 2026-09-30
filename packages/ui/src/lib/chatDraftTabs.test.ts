import { describe, expect, test } from 'bun:test';
import { createTabDrafts } from './chatDraftTabs';

// smarty-code#461 / openchamber#433 (design after round 5; cut items in smarty-code#1039): pages share one localStorage;
// each TAB has its own sessionStorage, kept across its reloads. A page is one createTabDrafts instance.
const memory = () => {
  const m = new Map<string, string>(); const writes: string[] = [], removes: string[] = [];
  return { writes, removes, map: m, getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => { removes.push(k); m.delete(k); }, setItem: (k: string, v: string) => { writes.push(k); m.set(k, v); return true; } };
};
const RT = 'rt', DIR = '/p';
const draft = (text: string, touchedAt: number) => ({ text, confirmedMentions: [], touchedAt });

describe('per-tab New session drafts (#461)', () => {
  test('two tabs on one project each keep their own draft; each reload restores its own (the 3.56 repro)', () => {
    const storage = memory(), sa = memory(), sb = memory();
    createTabDrafts({ storage, session: sa }).writeSlot(RT, DIR, draft('alpha-461', 1));
    createTabDrafts({ storage, session: sb }).writeSlot(RT, DIR, draft('beta-461', 2));
    expect(createTabDrafts({ storage, session: sa }).readSlot(RT, DIR)?.text).toBe('alpha-461'); // A reloads.
    expect(createTabDrafts({ storage, session: sb }).readSlot(RT, DIR)?.text).toBe('beta-461'); // B reloads.
  });

  test('a reload keeps the tab\'s id; a fresh tab gets another id and starts empty', () => {
    const storage = memory(), sa = memory();
    const a = createTabDrafts({ storage, session: sa }); a.writeSlot(RT, DIR, draft('alpha', 1));
    expect(createTabDrafts({ storage, session: sa }).tabId()).toBe(a.tabId());
    const fresh = createTabDrafts({ storage, session: memory() });
    expect(fresh.tabId()).not.toBe(a.tabId());
    expect(fresh.readSlot(RT, DIR)).toBeUndefined();
  });

  test('a tab writes and removes only its own slot: clearing its draft leaves another tab\'s', () => {
    const storage = memory(), sa = memory(), sb = memory();
    const a = createTabDrafts({ storage, session: sa }), b = createTabDrafts({ storage, session: sb });
    a.writeSlot(RT, DIR, draft('alpha', 1)); b.writeSlot(RT, DIR, draft('beta', 2));
    const mark = storage.writes.length; storage.removes.length = 0;
    a.writeSlot(RT, DIR, draft('alpha 2', 3)); a.writeSlot(RT, DIR, undefined);
    expect([...storage.writes.slice(mark), ...storage.removes].every(k => k === a.newSessionSlotKey(RT, DIR))).toBe(true);
    expect(b.readSlot(RT, DIR)?.text).toBe('beta');
  });

  test('the pre-#461 shared draft is copied once into a tab that has none; stored reports a refused copy', () => {
    const storage = memory();
    const a = createTabDrafts({ storage, session: memory() });
    expect(a.adoptLegacy(RT, DIR, draft('older', 1))).toEqual({ stored: true });
    expect(a.readSlot(RT, DIR)?.text).toBe('older');
    expect(a.adoptLegacy(RT, DIR, draft('older', 1))).toBe(false); // It has its own now.
    const refusing = { ...memory(), setItem: () => false };
    expect(createTabDrafts({ storage: refusing, session: memory() }).adoptLegacy(RT, DIR, draft('older', 1))).toEqual({ stored: false });
  });

  // SCOPE DECISION on openchamber#433 (5911825844), condition (a): no closed tab's draft is destroyed; smarty-code#1039
  // recovers it later. Nothing here removes or overwrites another tab's slot, whatever the other tabs do.
  test('a closed tab\'s slot stays in storage while other tabs save, clear and migrate the shared draft', () => {
    const storage = memory();
    const closed = createTabDrafts({ storage, session: memory() }); closed.writeSlot(RT, DIR, draft('unsent in a closed tab', 1));
    const key = closed.newSessionSlotKey(RT, DIR), kept = storage.getItem(key);
    for (let k = 0; k < 20; k++) {
      const other = createTabDrafts({ storage, session: memory() });
      other.adoptLegacy(RT, DIR, draft('shared', 0)); other.writeSlot(RT, DIR, draft(`other ${k}`, 2 + k)); other.writeSlot(RT, DIR, undefined);
    }
    expect(storage.getItem(key)).toBe(kept);
    expect(storage.removes).toEqual([]);
  });
});
