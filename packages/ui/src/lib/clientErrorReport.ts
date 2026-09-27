// A namespace import: test doubles of the runtime module may omit the key; then no report is scoped (nor sent).
import * as runtime from './runtime-switch';
const currentRuntime = (): string | undefined => runtime.getRuntimeKey?.();

/**
 * Every error the page shows a person is reported to the gateway, which logs it as `smarty.client-error`, so the fleet
 * sees it without the person telling anyone (smarty-code#536 item 3). The report carries the error as shown, redacted
 * (no query strings, tokens, addresses or quoted text; the route as a template), never the person's content. One report per
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

/** URLs keep origin and path; long opaque tokens and e-mail addresses are masked; at most 300 characters. */
export function redactClientError(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, url => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return '<url>'; } })
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    // Quoted text in an error is usually the person's own (a title, a message): never sent.
    .replace(/"[^"]{12,}"|“[^”]{12,}”|'[^']{12,}'/g, '"…"')
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '<redacted>')
    .slice(0, 300);
}
/** Path segments that name a thing (ids, tokens, encoded paths) become ':id'. */
const routeTemplate = (path: string) => path.split('/')
  .map(segment => (/\d/.test(segment) || segment.length > 20 ? ':id' : segment)).join('/').slice(0, 300);

export function reportClientError(report: ClientErrorReport, now = Date.now()): void {
  const runtimeKey = report.runtimeKey ?? currentRuntime();
  if (!runtimeKey || currentRuntime() !== runtimeKey) return; // Its server is gone: nowhere, never another server.
  const message = report.message ? redactClientError(report.message) : undefined;
  const key = `${runtimeKey}\0${report.kind}\0${report.sessionID ?? ''}\0${message ?? ''}`;
  const last = lastReport.get(key);
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) return;
  if (lastReport.size > 200) lastReport.clear();
  lastReport.set(key, now);
  const route = typeof location === 'undefined' ? undefined : routeTemplate(location.pathname);
  const body = {
    kind: report.kind.slice(0, 64),
    ...(message ? { message } : {}),
    ...(route ? { route } : {}),
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
export function resetClientErrorReportsForPage(): void { lastReport.clear(); }
