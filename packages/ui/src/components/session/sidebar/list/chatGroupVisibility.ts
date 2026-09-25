/**
 * The managed catalog admits no Chat target, so its empty "chats" block only pushed the
 * fleet's projects down (sidebar audit 2026-09-23). Show it there only when chats exist.
 */
export const showsChatGroup = ({ isVSCode, managedCatalog, chatSessionCount }:
  { isVSCode: boolean; managedCatalog: boolean; chatSessionCount: number }): boolean => (
  !isVSCode && (!managedCatalog || chatSessionCount > 0)
);

/**
 * Smarty Code mirrors Herdr, which has no "chats" or "recent" sections (smarty-code#126, Paul's Mac view). They show
 * only on a runtime confirmed stock, so a managed sidebar never flashes them (code-lead, OC#169).
 */
export const showsActivitySections = ({ isVSCode, stockConfirmed }: { isVSCode: boolean; stockConfirmed: boolean }): boolean => (
  !isVSCode && stockConfirmed
);
