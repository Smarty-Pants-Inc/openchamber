import { openRegisteredSettings } from '@/apps/deepLinkNavigation';
import { useUIStore } from '@/stores/useUIStore';

/** smarty-dev#799: opens Settings on the "Connect your iPhone" page. */
export function openConnectIphone(): void {
  // A phone shell opens Settings as its own full-screen surface; the desktop layout opens the Settings window.
  if (openRegisteredSettings('connect-iphone')) return;
  const ui = useUIStore.getState();
  ui.setSettingsPage('connect-iphone');
  ui.setSettingsDialogOpen(true);
}
