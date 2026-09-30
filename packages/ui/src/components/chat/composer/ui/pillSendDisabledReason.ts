/**
 * Why the collapsed phone composer's Send is off, or undefined when it is on. The same states that disable the expanded
 * composer's Send: an unavailable existing session (smarty-code#790), and a New session draft whose project is no longer
 * admitted (smarty-code#966; openchamber#441 r3: the collapsed Send stayed enabled there and did nothing).
 */
export function pillSendDisabledReason(o: { ordinaryUnavailable: boolean; newSessionDraftOpen: boolean; nativeMode: string },
  t: (key: 'chat.ordinary.sendUnavailableNow' | 'chat.nativeCreation.notAdmitted') => string): string | undefined {
  if (o.ordinaryUnavailable) return t('chat.ordinary.sendUnavailableNow');
  if (o.newSessionDraftOpen && o.nativeMode === 'notAdmitted') return t('chat.nativeCreation.notAdmitted');
  return undefined;
}
