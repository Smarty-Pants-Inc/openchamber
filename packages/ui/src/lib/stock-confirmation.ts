/**
 * Whether this runtime has AFFIRMATIVELY answered "stock" (smarty-code#126 (c), OC#169): set by a 'stock' answer, kept
 * across a later failed refresh ('unavailable'), cleared by managed admission or a runtime reset ('unknown'). A failure
 * with no prior stock answer (for example a managed runtime whose first discovery request fails) never confirms stock.
 */
export const nextStockConfirmed = (confirmed: boolean, { managedCatalog, catalogStatus }:
  { managedCatalog: boolean; catalogStatus: string }): boolean => (
  !managedCatalog && (catalogStatus === 'stock' || (confirmed && catalogStatus === 'unavailable'))
);
