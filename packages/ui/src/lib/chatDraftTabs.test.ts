import { describe, expect, test } from 'bun:test';
import { createTabDrafts } from './chatDraftTabs';

// smarty-code#461 / openchamber#433 (round 4 design, scope decision in smarty-code#1039): pages share one localStorage;
// each page has its own sessionStorage (a copy for a duplicated tab). A page is one createTabDrafts instance; a reload
// is a new instance on the same sessionStorage.
const memory = () => {
  const m = new Map<string, string>(); const writes: string[] = [], removes: string[] = [];
  return { writes, removes, map: m,
    getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { removes.push(k); m.delete(k); },
    setItem: (k: string, v: string) => { writes.push(k); m.set(k, v); return true; },
    key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } };
};
const RT = 'rt', DIR = '/p';
const draft = (text: string, touchedAt: number) => ({ text, confirmedMentions: [], touchedAt });
/** Keys of other pages' slots: any slot key not naming `mine`. */
const othersTouched = (s: ReturnType<typeof memory>, mine: string, from = 0) =>
  [...s.writes.slice(from), ...s.removes].filter(k => k.startsWith('openchamber.chatDraftSlot:') && !k.includes(mine));

describe('per-tab New session drafts (#461)', () => {
  test('two tabs on one project each keep their own draft; each reload restores its own (the 3.56 repro)', () => {
    const storage = memory(), sa = memory(), sb = memory();
    const a = createTabDrafts({ storage, session: sa }), b = createTabDrafts({ storage, session: sb });
    expect(a.adoptNewest(RT, DIR)).toBe(false); expect(b.adoptNewest(RT, DIR)).toBe(false); // Both open empty.
    a.writeSlot(RT, DIR, draft('alpha-461', 1)); b.writeSlot(RT, DIR, draft('beta-461', 2));
    const a2 = createTabDrafts({ storage, session: sa }); // A reloads.
    expect(a2.readSlot(RT, DIR)?.text).toBe('alpha-461');
    const b2 = createTabDrafts({ storage, session: sb }); // B reloads.
    expect(b2.readSlot(RT, DIR)?.text).toBe('beta-461');
  });

  test('a duplicated tab (its sessionStorage copied, the original still open) gets its own copy; their later drafts never mix', () => {
    const storage = memory(), sa = memory();
    const a = createTabDrafts({ storage, session: sa });
    a.writeSlot(RT, DIR, draft('alpha', 1));
    const copy = memory(); copy.setItem('openchamber.chatDraftTab', sa.getItem('openchamber.chatDraftTab')!);
    const d = createTabDrafts({ storage, session: copy }); // The duplicate loads while A is open.
    expect(d.tabId()).not.toBe(a.tabId());
    expect(d.readSlot(RT, DIR)?.text).toBe('alpha'); // Starts from a copy.
    d.writeSlot(RT, DIR, draft('delta', 2)); a.writeSlot(RT, DIR, draft('alpha 2', 3));
    expect(a.readSlot(RT, DIR)?.text).toBe('alpha 2');
    expect(createTabDrafts({ storage, session: copy }).readSlot(RT, DIR)?.text).toBe('delta'); // D's reload: its own.
    expect(createTabDrafts({ storage, session: sa }).readSlot(RT, DIR)?.text).toBe('alpha 2'); // A's reload: its own.
  });

  test('two copies of one tab loading at the same moment never share a key (each load takes a fresh id)', () => {
    const storage = memory(), s1 = memory(), s2 = memory();
    s1.setItem('openchamber.chatDraftTab', 'copied'); s2.setItem('openchamber.chatDraftTab', 'copied');
    storage.setItem(`openchamber.chatDraftSlot:${JSON.stringify([RT, DIR, 'copied'])}`, JSON.stringify(draft('shared start', 1)));
    const p = createTabDrafts({ storage, session: s1 }), q = createTabDrafts({ storage, session: s2 });
    expect(p.tabId()).not.toBe(q.tabId()); expect(p.tabId()).not.toBe('copied');
    p.writeSlot(RT, DIR, draft('from p', 2)); q.writeSlot(RT, DIR, draft('from q', 3));
    expect(p.readSlot(RT, DIR)?.text).toBe('from p'); expect(q.readSlot(RT, DIR)?.text).toBe('from q');
  });

  test('no page ever writes or removes another page\'s slot: not at load, not when copying, not when clearing its own', () => {
    const storage = memory(), sa = memory(), sb = memory();
    const a = createTabDrafts({ storage, session: sa }); a.writeSlot(RT, DIR, draft('alpha', 1));
    const mark = storage.writes.length; storage.removes.length = 0;
    const copy = memory(); copy.setItem('openchamber.chatDraftTab', sa.getItem('openchamber.chatDraftTab')!);
    const d = createTabDrafts({ storage, session: copy }); d.readSlot(RT, DIR); d.writeSlot(RT, DIR, draft('d', 2)); d.writeSlot(RT, DIR, undefined);
    // A's page closes (earlier designs released a claim key here; this one has none), then a fresh tab copies its draft.
    for (const k of [...storage.map.keys()]) if (k.startsWith('openchamber.chatDraftTabClaim:')) storage.map.delete(k);
    const b = createTabDrafts({ storage, session: sb }); b.adoptNewest(RT, DIR); b.writeSlot(RT, DIR, draft('b', 4)); b.writeSlot(RT, DIR, undefined);
    expect(othersTouched(storage, d.tabId(), mark).filter(k => !k.includes(b.tabId()))).toEqual([]);
    expect(a.readSlot(RT, DIR)?.text).toBe('alpha');
  });

  test('a fresh tab copies the newest draft of the project (or the pre-#461 one if newer), once, read only', () => {
    const storage = memory();
    const a = createTabDrafts({ storage, session: memory() }); a.writeSlot(RT, DIR, draft('older', 1));
    const b = createTabDrafts({ storage, session: memory() }); b.writeSlot(RT, DIR, draft('newest', 5));
    const c = createTabDrafts({ storage, session: memory() });
    expect(c.adoptNewest(RT, DIR, draft('pre-461', 3))).toEqual({ from: 'tab', stored: true });
    expect(c.readSlot(RT, DIR)?.text).toBe('newest');
    c.writeSlot(RT, DIR, undefined); expect(c.adoptNewest(RT, DIR)).toBe(false); // Once: a cleared copy stays cleared.
    const e = createTabDrafts({ storage: memory(), session: memory() });
    expect(e.adoptNewest(RT, DIR, draft('pre-461', 3))).toEqual({ from: 'legacy', stored: true });
    const reloaded = createTabDrafts({ storage, session: memory() }); // A reload (previous id) never adopts others.
    reloaded.tabId(); expect(createTabDrafts({ storage, session: (() => { const s = memory(); s.setItem('openchamber.chatDraftTab', a.tabId()); return s; })() }).adoptNewest(RT, DIR)).toBe(false);
    void reloaded;
  });

  test('a refused copy is reported as not stored', () => {
    const storage = memory(); createTabDrafts({ storage, session: memory() }).writeSlot(RT, DIR, draft('alpha', 1));
    const refusing = { ...storage, get length() { return storage.length; }, setItem: (k: string, v: string) => (k.includes('chatDraftSlot') ? false : storage.setItem(k, v)) };
    expect(createTabDrafts({ storage: refusing, session: memory() }).adoptNewest(RT, DIR)).toEqual({ from: 'tab', stored: false });
  });

  // openchamber#433 round 4, P1 1: at quota the reload's copy is refused; the earlier slot must stay reachable.
  test('a refused reload copy: the next load on the same tab still finds the earlier draft, also once storage recovers', () => {
    const storage = memory(), sa = memory(); let refuse = false; const refused: string[] = [];
    const guarded = { ...storage, get length() { return storage.length; },
      setItem: (k: string, v: string) => { if (refuse && k.startsWith('openchamber.chatDraftSlot:')) { refused.push(k); return false; } return storage.setItem(k, v); } };
    createTabDrafts({ storage: guarded, session: sa }).writeSlot(RT, DIR, draft('alpha', 1));
    refuse = true;
    const second = createTabDrafts({ storage: guarded, session: sa }); let told = 0; second.onCopyRefused(() => { told++; });
    expect(second.readSlot(RT, DIR)?.text).toBe('alpha'); // Shown (from memory), the copy refused, and reported:
    expect(refused.length).toBe(1); expect(told).toBe(1);
    const third = createTabDrafts({ storage: guarded, session: sa }); // Another reload, still at quota.
    expect(third.readSlot(RT, DIR)?.text).toBe('alpha');
    refuse = false;
    const fourth = createTabDrafts({ storage: guarded, session: sa }); // Storage available again.
    expect(fourth.readSlot(RT, DIR)?.text).toBe('alpha');
    expect(createTabDrafts({ storage: guarded, session: sa }).readSlot(RT, DIR)?.text).toBe('alpha');
  });

  // openchamber#433 round 4, P1 2: a cleared or sent draft never comes back from an earlier load's slot.
  for (const how of ['cleared', 'sent (consumed after the admitted mark)'] as const) test(`save, reload, then ${how}: neither a reload nor a fresh tab restores it; another tab's draft stays`, () => {
    const storage = memory(), sa = memory();
    const other = createTabDrafts({ storage, session: memory() }); other.writeSlot(RT, '/other', draft('unrelated', 1));
    const bee = createTabDrafts({ storage, session: memory() }); bee.writeSlot(RT, DIR, draft('b unsent', 2));
    createTabDrafts({ storage, session: sa }).writeSlot(RT, DIR, draft('hello', 3));
    const reloaded = createTabDrafts({ storage, session: sa });
    expect(reloaded.readSlot(RT, DIR)?.text).toBe('hello');
    reloaded.writeSlot(RT, DIR, undefined); // Clear, or the sent text consumed (consumeChatDraft writes the empty draft).
    expect(createTabDrafts({ storage, session: sa }).readSlot(RT, DIR)).toBeUndefined(); // Reload: not restored.
    const fresh = createTabDrafts({ storage, session: memory() });
    fresh.adoptNewest(RT, DIR);
    expect(fresh.readSlot(RT, DIR)?.text).not.toBe('hello'); // Never the cleared or sent text...
    expect(fresh.readSlot(RT, DIR)?.text).toBe('b unsent'); // ...the other tab's current draft instead.
    expect(bee.readSlot(RT, DIR)?.text).toBe('b unsent'); expect(other.readSlot(RT, '/other')?.text).toBe('unrelated');
  });
});
