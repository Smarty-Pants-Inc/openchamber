/**
 * The managed catalog admits no Chat target, so its empty "chats" block only pushed the
 * fleet's projects down (sidebar audit 2026-09-23). Show it there only when chats exist.
 */
export const showsChatGroup = ({ isVSCode, managedCatalog, chatSessionCount }:
  { isVSCode: boolean; managedCatalog: boolean; chatSessionCount: number }): boolean => (
  !isVSCode && (!managedCatalog || chatSessionCount > 0)
);

type CatalogView = { managedCatalog: boolean; catalogStatus: string };

/**
 * Whether this runtime has AFFIRMATIVELY answered "stock": set by a 'stock' answer, kept across a later failed refresh
 * ('unavailable'), cleared by managed admission. A failure with no prior stock answer (for example a managed runtime
 * whose first discovery request fails) never confirms stock.
 */
export const nextStockConfirmed = (confirmed: boolean, { managedCatalog, catalogStatus }: CatalogView): boolean => (
  !managedCatalog && (catalogStatus === 'stock' || (confirmed && catalogStatus === 'unavailable'))
);

/**
 * Smarty Code mirrors Herdr, which has no "chats" or "recent" sections (smarty-code#126, Paul's Mac view). They show
 * only on a runtime confirmed stock, so a managed sidebar never flashes them (code-lead, OC#169).
 */
export const showsActivitySections = ({ isVSCode, stockConfirmed }: { isVSCode: boolean; stockConfirmed: boolean }): boolean => (
  !isVSCode && stockConfirmed
);
