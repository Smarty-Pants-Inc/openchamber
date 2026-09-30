import { z } from 'zod';
// A namespace import: test doubles of the runtime module may omit the key; then no report is scoped (nor sent).
import * as runtime from './runtime-switch';
const currentRuntime = (): string | undefined => runtime.getRuntimeKey?.();

/**
 * The page's failures reach the fleet without the person telling anyone (smarty-code#536 item 3): the gateway logs each
 * report as `smarty.client-error`. Reports come only from OPERATIONS (a history load, a send, a start, a steer, a fork,
 * a settings save, a context pin, an upgrade, the small model, a turn the page settled itself), each scoped to the
 * server it started on and named by a stable kind and its operation id. Generic error toasts do not report: which
 * server their operation started on is not known where they are shown. The report carries codes and fixed text, never
 * the person's content, the server's words or the page's route. Reporting never fails the page.
 */
export type ClientErrorReport = {
  kind: string;
  /** The operation that failed: one report per (kind, operation), however often its failure is shown. */
  operationId: string;
  /** The server the operation STARTED on, captured before its first await. Only that server gets the report, and only
   * while it is still the page's server: after a switch the report is dropped, never sent to another server. */
  runtimeKey: string;
  message?: string;
  sessionID?: string;
  status?: number;
};
const reported = new Set<string>();
/** What the gateway receives (smarty-code#552 accepts exactly these fields). */
type ReportBody = { kind: string; at: number; message?: string; sessionID?: string; status?: number };

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

/** A new operation's id: an operation that has none of its own (a fork, a save) takes one at its start. */
export const newOperationId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export function reportClientError(report: ClientErrorReport, now = Date.now()): void {
  const { runtimeKey } = report;
  if (!runtimeKey || currentRuntime() !== runtimeKey) return; // Its server is gone: nowhere, never another server.
  const key = `${runtimeKey}\0${report.kind}\0${report.operationId}`;
  if (reported.has(key)) return; // The same failure again (shown twice, or re-rendered): one report.
  reported.add(key);
  // Bounded: the oldest operations are forgotten one by one (a Set keeps insertion order), never all at once.
  if (reported.size > 500) reported.delete(reported.values().next().value!);
  // No route: a page path can name the person's own things; the session says where.
  const body: ReportBody = { kind: report.kind.slice(0, 64), at: now };
  if (report.message) body.message = redactClientError(report.message);
  if (report.sessionID) body.sessionID = report.sessionID.slice(0, 200);
  if (report.status !== undefined && Number.isInteger(report.status) && report.status >= 0 && report.status <= 999) body.status = report.status;
  // Loaded on first use (the modules that fail take no network dependency by importing this); sent only to the
  // operation's own server.
  void import('./runtime-fetch').then(({ runtimeFetch }) => {
    if (currentRuntime() !== runtimeKey) return;
    return runtimeFetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), keepalive: true });
  }).catch(() => undefined); // Best-effort: the page goes on.
}

/**
 * The catch-all: an error nothing handled (a crash outside any operation, at boot or later) is reported as
 * `page.unhandled` to the page's server when it fires, with its error name only (a code, never its message). One per
 * name per 30 s. Errors without an error object (a cross-origin "Script error.", a ResizeObserver notice) are not.
 */
// Error names that are code, never content: the language's own and the platform's (DOMException) common ones.
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
  'AggregateError', 'AbortError', 'TimeoutError', 'NetworkError', 'NotFoundError', 'NotAllowedError', 'NotSupportedError',
  'InvalidStateError', 'QuotaExceededError', 'SecurityError', 'DataCloneError', 'ChunkLoadError']);
const lastUnhandled = new Map<string, number>();
export function reportUnhandled(error: Error, now = Date.now()): void {
  const code = ERROR_NAMES.has(error.name) ? error.name : 'Error';
  const runtimeKey = currentRuntime();
  if (!runtimeKey) return;
  const last = lastUnhandled.get(code);
  if (last !== undefined && now - last < 30_000) return;
  lastUnhandled.set(code, now);
  reportClientError({ kind: 'page.unhandled', message: code, runtimeKey, operationId: `${code}:${now}` }, now);
}

/**
 * What a failed operation's report says about its error (smarty-code#1058): its name and its HTTP status, found on the
 * error or on its `cause` chain (a wrapped SDK failure keeps the fetch's own error there). A failure that got no HTTP
 * answer is named with ` (network)`. An aborted request (AbortError) is no failure: null, not reported.
 */
const HttpStatus = z.union([z.object({ status: z.number().int() }), z.object({ response: z.instanceof(Response) })
  .transform(({ response }) => ({ status: response.status }))]);
export function failureReport(error: Error): { message: string; status?: number } | null {
  let name = 'Error', status: number | undefined, network = false;
  for (let at: Error | undefined = error, depth = 0; at && depth < 5; at = at.cause instanceof Error ? at.cause : undefined, depth++) {
    if (at.name === 'AbortError') return null;
    // Only a class-shaped name is a code; anything else could be content.
    if (name === 'Error' && /^[A-Z][A-Za-z]{0,40}Error$/.test(at.name)) name = at.name;
    network ||= at.name === 'TypeError' || at.name === 'NetworkError';
    status ??= HttpStatus.safeParse(at).data?.status;
  }
  return { message: status === undefined && network ? `${name} (network)` : name, status };
}

let listening = false;
/** Installed once, as early as the page loads this module (the sync layer imports it at boot). */
export function listenForUnhandledErrors(target: Pick<Window, 'addEventListener'> | undefined = globalThis.window): void {
  if (listening || !target) return;
  listening = true;
  // Only an Error object: a thrown non-error (an object, a string) may be anything, and is not sent.
  target.addEventListener('error', event => { if ('error' in event && event.error instanceof Error) reportUnhandled(event.error); });
  target.addEventListener('unhandledrejection', event => {
    if ('reason' in event && event.reason instanceof Error) reportUnhandled(event.reason);
  });
}
listenForUnhandledErrors();

/** Tests model a page load. */
export function resetClientErrorReportsForPage(): void {
  reported.clear(); lastUnhandled.clear();
}
