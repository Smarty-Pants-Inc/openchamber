import type { NewSessionDraftState } from './session-ui-store';

/**
 * This tab's persisted state for a new-session draft's start (smarty-code#126, #117): the draft's token across a reload,
 * the create request id whose outcome is not known yet, and the "sent, start pending" mark. All in sessionStorage, so
 * another window never shares it and a reload of this tab keeps it.
 */
const listeners = new Set<() => void>();
export const notifyDraftStart = () => listeners.forEach(listener => listener());
export const subscribeDraftStart = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * The draft's identity across a reload (#304/OC#182 review). draftId is a page-local counter, so each draft gets a
 * token instead. The token of the latest draft per runtime and project is kept in sessionStorage. Only the startup
 * restore (the automatic open, `restored`) takes it back after a reload, and only once per page. Any explicit New
 * session gets a new token, so it never takes over an earlier draft's start.
 */
const pageTokens = new Map<string, string>(), claimed = new Set<string>();
export function draftToken(draft: NewSessionDraftState, runtimeKey: string): string {
  const page = JSON.stringify([runtimeKey, draft.draftId, draft.directoryOverride]);
  const known = pageTokens.get(page);
  if (known) return known;
  const slot = `oc.nativeCreation.draft:${JSON.stringify([runtimeKey, draft.directoryOverride])}`;
  let token: string | undefined;
  try { token = draft.restored && !claimed.has(slot) ? sessionStorage.getItem(slot) ?? undefined : undefined; } catch { /* no storage */ }
  token ??= crypto.randomUUID();
  try { sessionStorage.setItem(slot, token); } catch { /* no storage: the token still separates drafts in this page */ }
  claimed.add(slot); pageTokens.set(page, token);
  return token;
}
/** A page load starts with no claimed drafts; tests call this to model a reload of the same tab. */
export function resetNativeDraftPage(): void { pageTokens.clear(); claimed.clear(); }

/**
 * This draft's outstanding create request id (smarty-code#126, OC#167 review): sessionStorage, so another window never
 * shares it and a reload of this tab keeps it. A lost create response is recovered only by an exact match on it.
 */
export const requestKey = (draft: NewSessionDraftState, runtimeKey: string) =>
  `oc.nativeCreation.request:${JSON.stringify([runtimeKey, draft.directoryOverride, draftToken(draft, runtimeKey)])}`;
export const storedRequestId = (key: string) => { try { return sessionStorage.getItem(key) ?? undefined; } catch { return undefined; } };
export function newRequestId(key: string): string {
  const id = crypto.randomUUID();
  try { sessionStorage.setItem(key, id); } catch { /* no storage: the id still correlates within this page */ }
  notifyDraftStart();
  return id;
}
export const forgetRequestId = (key: string) => {
  try { sessionStorage.removeItem(key); } catch { /* no storage */ }
  notifyDraftStart();
};

