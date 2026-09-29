/**
 * A page that outlives an install keeps the previous release's JavaScript: a reconnect restores its event stream, not its
 * bundle (smarty-code: Kate's page marked a finished tool "Interrupted" on 3.41 because it still ran 3.40). On a
 * reconnect, the page compares the hashed entry script it runs with the one the server now serves, and reloads when they
 * differ. It never reloads while that would lose anything: text in the composer (whether and where a draft is saved
 * depends on settings, storage, tabs and the page's route, so a reload waits while there is any), attached files, or a
 * send still being prepared or admitted (openchamber#333 reviews). It reloads at the next reconnect instead.
 */
const ENTRY = /<script[^>]*\btype="module"[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/i;

/** The entry script `html` loads (the hashed `/assets/…js` module), or undefined. */
export function entryScript(html: string): string | undefined {
  return ENTRY.exec(html)?.[1];
}

/** The entry script this page runs, from its own document. */
export function runningEntry(doc: Document = document): string | undefined {
  const script = [...doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map((element) => element.getAttribute("src") ?? "")
    .find((src) => /\/assets\/[^/]+\.js$/.test(src));
  return script || undefined;
}

const holds = new Set<() => boolean>();
/** Holds automatic reloads while `when()` is true (read at each reload decision) until the returned release is called. */
export function holdReload(when: () => boolean = () => true): () => void {
  holds.add(when);
  return () => void holds.delete(when);
}
/** Whether anything holds automatic reloads now. */
export const reloadHeld = (): boolean => [...holds].some((when) => { try { return when(); } catch { return true; } });

type Deps = {
  running: () => string | undefined;
  fetchIndex: () => Promise<string>;
  busy: () => boolean;
  reload: () => void;
  /** This tab's delay before it reloads (default none); each tab draws its own, so an install does not reload every
   * open tab at the same instant (3.54: 227 slow reads in 5 min from that burst). */
  jitterMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** A tab's random wait before a new-build reload: 0-60 s. */
export const defaultReloadJitterMs = (): number => Math.floor(Math.random() * 60_000);

/** Reloads the page when the server serves another build than the one it runs. Returns whether it reloaded. */
export async function reloadIfNewBuild(deps: Deps): Promise<boolean> {
  const running = deps.running();
  if (!running) return false;
  const served = entryScript(await deps.fetchIndex().catch(() => ""));
  if (!served || served === running || deps.busy()) return false;
  const wait = deps.jitterMs?.() ?? 0;
  if (wait > 0) {
    await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(wait);
    if (deps.busy()) return false; // Held meanwhile (text typed, a send begun): the next reconnect tries again.
  }
  deps.reload();
  return true;
}
