/**
 * Whether a phone's full-screen surface covers the chat (smarty-code#455: a covered chat holds no View only watch).
 * A tablet shows these surfaces as a dialog beside the chat, so it never covers it. The instances surface is shown only
 * with the Capacitor features.
 */
export function mobileChatCovered(surface: 'instances' | 'settings' | 'update' | null, variant: 'dialog' | 'fullscreen',
  capacitorFeatures: boolean): boolean {
  if (variant !== 'fullscreen' || surface === null) return false;
  return surface !== 'instances' || capacitorFeatures;
}
