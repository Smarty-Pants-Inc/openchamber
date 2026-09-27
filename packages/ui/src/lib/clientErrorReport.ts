/**
 * Every error the page shows a person is reported to the gateway, which logs it as `smarty.client-error`, so the fleet
 * sees it without the person telling anyone (smarty-code#536 item 3). The report carries the error as shown (never the
 * person's content), where it was shown, and when; at most one per kind per 30 s. Reporting never fails the page.
 */
export type ClientErrorReport = { kind: string; message?: string; sessionID?: string; status?: number };
const REPORT_INTERVAL_MS = 30_000;
const MESSAGE_LIMIT = 1000;
const lastReport = new Map<string, number>();

export function reportClientError(report: ClientErrorReport, now = Date.now()): void {
  const last = lastReport.get(report.kind);
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) return;
  lastReport.set(report.kind, now);
  const route = typeof location === 'undefined' ? undefined : location.pathname;
  const body = {
    kind: report.kind,
    ...(report.message ? { message: report.message.slice(0, MESSAGE_LIMIT) } : {}),
    ...(route ? { route: route.slice(0, 300) } : {}),
    ...(report.sessionID ? { sessionID: report.sessionID.slice(0, 200) } : {}),
    ...(Number.isInteger(report.status) && report.status! >= 0 && report.status! <= 999 ? { status: report.status } : {}),
    at: now,
  };
  // Loaded on first use: modules that show errors (the toast, the loader) take no network dependency by importing this.
  void import('./runtime-fetch').then(({ runtimeFetch }) => runtimeFetch('/api/client-error', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }))
    .catch(() => undefined); // Best-effort: the page goes on.
}

/** Tests model a page load. */
export function resetClientErrorReportsForPage(): void { lastReport.clear(); }
