// Test setup (import FIRST): a window with durable localStorage and sessionStorage, so the safe-storage adapter reports
// saves as stored (without a window it keeps memory only and reports every save as not durable; openchamber#433 r2 P1 4
// commits a copy only after a durable save).
const make = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); },
    clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
};
// SAFETY: test setup only; `window` is read, and set here only when no DOM set it first.
const g = globalThis as { window?: object };
if (!('window' in g) || g.window === undefined) g.window = { localStorage: make(), sessionStorage: make(), addEventListener: () => {}, location: { search: '' } };
export {};
