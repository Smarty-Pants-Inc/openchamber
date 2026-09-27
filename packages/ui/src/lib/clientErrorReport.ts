// A namespace import: test doubles of the runtime module may omit the key; then no report is scoped (nor sent).
import * as runtime from './runtime-switch';
const currentRuntime = (): string | undefined => runtime.getRuntimeKey?.();
/**
 * A report without its operation's runtime (a generic toast) goes to the server that is the page's when it is shown,
 * as a person's action would: it carries no content, only which code showed an error. A report that carries its
 * operation's runtime goes to that server only, and is dropped once the page has left it.
 */

/**
 * A generic toast's diagnostic identity: the code location that showed it (bundle file, line, column), read from the
 * stack. It names code, never content, and tells one failing site from another. `depth`: frames above the caller.
 */
export function callSiteCode(stack: string | undefined, depth: number): string {
  const frames = (stack ?? '').split('\n')
    .map(line => /([^/\\\s()@]+?)\.[cm]?[jt]sx?(?:\?[^:\s)]*)?:(\d+):(\d+)/.exec(line)).filter(Boolean) as RegExpExecArray[];
  const frame = frames[depth];
  return frame ? `toast.${frame[1].replace(/[^A-Za-z0-9_-]/g, '-')}.${frame[2]}.${frame[3]}`.slice(0, 64) : 'toast';
}

/**
 * Every error the page shows a person is reported to the gateway, which logs it as `smarty.client-error`, so the fleet
 * sees it without the person telling anyone (smarty-code#536 item 3). The report carries the error as shown, redacted
 * (codes and fixed text; no route; anything free-form redacted), never the person's content. One report per
 * diagnostic (kind, session, message) per 30 s. Reporting never fails the page.
 */
/**
 * `runtimeKey`: the server the failing operation belonged to, captured before its first await. The report goes to that
 * server only, and only while it is still the page's server (its own credentials); after a switch it is dropped, never
 * sent to another server. Without it, the server shown when the error is shown (a toast has no operation of its own).
 */
export type ClientErrorReport = { kind: string; message?: string; sessionID?: string; status?: number; runtimeKey?: string };
const REPORT_INTERVAL_MS = 30_000;
const lastReport = new Map<string, number>();

/** URLs keep origin and path; long opaque tokens, e-mail addresses, quoted text, file names and paths are masked; at most 300 characters. */
export function redactClientError(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, url => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '<url>'; } })
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    // Quoted text in an error is usually the person's own (a title, a message, a file name): never sent, whatever its length.
    .replace(/"[^"]+"|“[^”]+”|‘[^’]+’|«[^»]+»|`[^`]+`/g, '"…"')
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '<redacted>')
    // File names and paths are the person's content too, quoted or not.
    .replace(/(?<![\w:/.])(?:~|\.{1,2})?\/[^\s"'<>:,;]+/g, '<path>')
    .replace(/(?<![/\w.-])[^\s"'<>()/]+\.[A-Za-z0-9]{1,8}\b(?!\/)/g, '<file>')
    .slice(0, 300);
}

/**
 * One report per error a person sees. Each error toast is one (told apart by its site), and never holds another back.
 * An operation that reports its own failure (shown inline or in the transcript) runs through its callers in one task
 * (their catches are microtasks of it): a toast they show in that task is its display, and a further operation report
 * for the same session its consequence (the loader, then the start it refused). Neither is reported again. The record
 * clears at the next task. ponytail: the event loop's own boundary, not a guess by time.
 */
let operationsThisTask: Array<string | undefined> | undefined;
const isGenericToast = (kind: string) => kind === 'toast' || kind.startsWith('toast.');

export function reportClientError(report: ClientErrorReport, now = Date.now()): void {
  if (operationsThisTask) {
    if (isGenericToast(report.kind)) return;
    if (operationsThisTask.some(earlier => !earlier || !report.sessionID || earlier === report.sessionID)) return;
  }
  const runtimeKey = report.runtimeKey ?? currentRuntime();
  if (!runtimeKey || currentRuntime() !== runtimeKey) return; // Its server is gone: nowhere, never another server.
  // Only a report that is the page's server's marks its task (a dropped old-server failure holds nothing back).
  if (!isGenericToast(report.kind)) {
    if (!operationsThisTask) { operationsThisTask = []; setTimeout(() => { operationsThisTask = undefined; }, 0); }
    operationsThisTask.push(report.sessionID);
  }
  const message = report.message ? redactClientError(report.message) : undefined;
  const key = `${runtimeKey}\0${report.kind}\0${report.sessionID ?? ''}\0${message ?? ''}`;
  const last = lastReport.get(key);
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) return;
  if (lastReport.size > 200) lastReport.clear();
  lastReport.set(key, now);
  const body = {
    kind: report.kind.slice(0, 64),
    ...(message ? { message } : {}),
    // No route: a page path can name the person's own things; the session says where.
    ...(report.sessionID ? { sessionID: report.sessionID.slice(0, 200) } : {}),
    ...(Number.isInteger(report.status) && report.status! >= 0 && report.status! <= 999 ? { status: report.status } : {}),
    at: now,
  };
  // Loaded on first use (the modules that show errors take no network dependency by importing this); sent only to the
  // server the error was shown for.
  void import('./runtime-fetch').then(({ runtimeFetch }) => {
    if (currentRuntime() !== runtimeKey) return;
    return runtimeFetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), keepalive: true });
  }).catch(() => undefined); // Best-effort: the page goes on.
}

/** Tests model a page load. */
export function resetClientErrorReportsForPage(): void {
  lastReport.clear(); operationsThisTask = undefined;
}
