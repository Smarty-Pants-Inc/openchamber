// smarty-code#1407: the app's loading splash (index.html's #initial-loading) normally waits for the old view's
// bootstrap (config, providers, sessions). The Smarty view needs none of it, so once it has painted from its feed it
// lifts the splash itself, with the app's own fade. Idempotent: a later App dismissal finds nothing to remove.
export function dismissInitialLoading(): void {
  const element = globalThis.document?.getElementById('initial-loading');
  if (!element || element.classList.contains('fade-out')) return;
  element.classList.add('fade-out');
  setTimeout(() => element.remove(), 300);
}
