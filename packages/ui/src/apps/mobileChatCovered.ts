/**
 * Whether a phone's full-screen surface covers the chat (smarty-code#455: a covered chat holds no View only watch).
 * A tablet shows these surfaces as a dialog beside the chat, so it never covers it. The instances surface is shown only
 * with the Capacitor features.
 */
export function mobileChatCovered(surface: 'instances' | 'settings' | 'update' | null, variant: 'dialog' | 'fullscreen',
  capacitorFeatures: boolean, planOpen = false): boolean {
  if (variant !== 'fullscreen') return false;
  if (planOpen) return true; // A saved Plan, opened above the workspace drawer's Notes.
  return surface !== null && (surface !== 'instances' || capacitorFeatures);
}
