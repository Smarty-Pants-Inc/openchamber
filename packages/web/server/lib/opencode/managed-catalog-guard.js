// A managed launcher (smarty-code) owns the project catalog. In that mode this server creates no
// folders and registers no new projects, whatever the UI shows (#126 item 8). Stock when unset.
export const MANAGED_CATALOG_ENV = 'OPENCHAMBER_MANAGED_CATALOG';

export const isManagedCatalog = (env = process.env) => env?.[MANAGED_CATALOG_ENV] === '1';

export const MANAGED_CATALOG_REFUSAL = 'Projects come from the managed project catalog. This server does not create folders or add projects.';

/** Register before the owning routes so a refusal happens before any filesystem or settings change. */
export const registerManagedCatalogGuard = (app, { env = process.env, readSettingsFromDisk, sanitizeProjects }) => {
  const refuse = (res) => res.status(403).json({ error: MANAGED_CATALOG_REFUSAL });
  const refuseWhenManaged = (_req, res, next) => (isManagedCatalog(env) ? refuse(res) : next());

  // POST /api/fs/mkdir decides in its own route: it needs the explicit directory and the chats root.
  app.post('/api/fs/clone', refuseWhenManaged);
  app.post('/api/opencode/directory', refuseWhenManaged);

  // Bookmark edits (rename, color, reorder, remove) stay allowed; a project path not already saved does not.
  app.put('/api/config/settings', async (req, res, next) => {
    if (!isManagedCatalog(env) || !Array.isArray(req.body?.projects)) return next();
    try {
      const savedPaths = new Set((sanitizeProjects((await readSettingsFromDisk()).projects) || []).map((project) => project.path));
      const incoming = sanitizeProjects(req.body.projects) || [];
      return incoming.some((project) => !savedPaths.has(project.path)) ? refuse(res) : next();
    } catch (error) {
      console.error('[managed-catalog] Failed to check a settings project update:', error);
      return res.status(500).json({ error: 'Failed to save settings' });
    }
  });
};
