// Its own module so tests that mock useDirectoryStore keep these (smarty-code#113).
/**
 * This browser's own last directory choice (smarty-code#113). `lastDirectory` in local storage mirrors the shared
 * settings on every settings sync, so it cannot tell this browser's choice from another browser's. This key is
 * written only by an explicit choice in this browser and is never mirrored from shared settings.
 */
export const BROWSER_LAST_DIRECTORY_KEY = 'oc.browser.lastDirectory';

// Counts explicit directory choices in this page, including choosing the directory already shown.
let explicitDirectoryChoices = 0;
export const getExplicitDirectoryChoices = (): number => explicitDirectoryChoices;
export const recordExplicitDirectoryChoice = (): void => { explicitDirectoryChoices += 1; };

/**
 * A browser upgrading from a release without the key keeps its proven local intent: seed the key, before any settings
 * sync runs, from the remembered draft target (a project target), else the local `lastDirectory`. Never from shared
 * settings; the local `lastDirectory` still holds this browser's last write here, before the first mirror (#113).
 */
export const seedBrowserLastDirectory = (storage: Pick<Storage, 'getItem' | 'setItem'>): void => {
  if (storage.getItem(BROWSER_LAST_DIRECTORY_KEY)) return;
  let seed: string | null = null;
  try {
    const target = JSON.parse(storage.getItem('oc.chatInput.lastDraftTarget') ?? 'null') as { target?: unknown; directory?: unknown } | null;
    if (target?.target === 'project' && typeof target.directory === 'string' && target.directory) seed = target.directory;
  } catch { /* an unreadable record proves nothing */ }
  seed ??= storage.getItem('lastDirectory');
  if (seed) storage.setItem(BROWSER_LAST_DIRECTORY_KEY, seed);
};
