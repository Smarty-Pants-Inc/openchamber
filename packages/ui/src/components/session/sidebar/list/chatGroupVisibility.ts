/**
 * The managed catalog admits no Chat target, so its empty "chats" block only pushed the
 * fleet's projects down (sidebar audit 2026-09-23). Show it there only when chats exist.
 */
export const showsChatGroup = ({ isVSCode, managedCatalog, chatSessionCount }:
  { isVSCode: boolean; managedCatalog: boolean; chatSessionCount: number }): boolean => (
  !isVSCode && (!managedCatalog || chatSessionCount > 0)
);
