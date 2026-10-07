/**
 * Test support: Bun has no Web Locks and no localStorage, which every supported browser runtime provides. Ordinary Send
 * admission refuses without them (smarty-code#1427), so fixtures that send to an ordinary session install in-memory ones
 * first. Existing ones (a browser, Node, happy-dom, or a test's own recording manager) are kept.
 */
export function ensureTestWebLocks(): void {
  let storageUsable = false;
  try { globalThis.localStorage.getItem('oc.test.probe'); storageUsable = true; } catch { /* Missing or unusable. */ }
  if (!storageUsable) {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } });
  }
  if (globalThis.navigator?.locks) return;
  const held = new Set<string>();
  const locks = {
    async request<T>(name: string, options: LockOptions | ((lock: Lock | null) => T | Promise<T>),
      callback?: (lock: Lock | null) => T | Promise<T>): Promise<T> {
      const work = callback ?? (options instanceof Function ? options : undefined);
      if (!work) throw new TypeError('A lock request needs a callback');
      const ifAvailable = !(options instanceof Function) && options.ifAvailable === true;
      if (held.has(name)) {
        if (ifAvailable) return work(null);
        throw new Error(`Test lock manager: ${name} is already held`);
      }
      held.add(name);
      try { return await work({ name, mode: 'exclusive' }); } finally { held.delete(name); }
    },
    async query() { return { held: [...held].map(name => ({ name, mode: 'exclusive' as const })), pending: [] }; },
  };
  // Add to the existing navigator (happy-dom's keeps its prototype getters, such as userAgent); create one only if absent.
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: locks });
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
}
