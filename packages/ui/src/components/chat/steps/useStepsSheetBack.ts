import React from 'react';

/** The open phone All steps sheet's close action, read by the shell's native Back handler. */
export type StepsSheetDismiss = React.RefObject<(() => void) | null>;

/** Native Back closes the open phone sheet first; false leaves Back to the shell's other layers. */
export function useStepsSheetBack() {
  const sheet: StepsSheetDismiss = React.useRef(null);
  const closeSheet = React.useCallback(() => {
    const close = sheet.current;
    if (!close) return false;
    close();
    return true;
  }, []);
  return { sheet, closeSheet };
}
