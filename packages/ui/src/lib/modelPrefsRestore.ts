// Restoring a session's model/effort/agent is not a user choice (smarty-code#117, #126 F6): the local
// recents still update, but only an explicit pick publishes them to the shared settings. No imports, so the
// chat controls can mark a restore without loading the settings persistence.
let restoringDepth = 0;
export const restoringModelPrefs = () => restoringDepth > 0;
export const withoutSharingModelPrefs = <T>(run: () => T): T => {
  restoringDepth += 1;
  try { return run(); } finally { restoringDepth -= 1; }
};
