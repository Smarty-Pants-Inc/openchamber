/**
 * A page that outlives an install keeps the previous release's JavaScript: a reconnect restores its event stream, not its
 * bundle (smarty-code: Kate's page marked a finished tool "Interrupted" on 3.41 because it still ran 3.40). On a
 * reconnect, the page compares the hashed entry script it runs with the one the server now serves, and reloads when they
 * differ. Composer drafts persist across a reload; attached files do not, so it waits while any are attached.
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

type Deps = {
  running: () => string | undefined;
  fetchIndex: () => Promise<string>;
  busy: () => boolean;
  reload: () => void;
};

/** Reloads the page when the server serves another build than the one it runs. Returns whether it reloaded. */
export async function reloadIfNewBuild(deps: Deps): Promise<boolean> {
  const running = deps.running();
  if (!running) return false;
  const served = entryScript(await deps.fetchIndex().catch(() => ""));
  if (!served || served === running || deps.busy()) return false;
  deps.reload();
  return true;
}
