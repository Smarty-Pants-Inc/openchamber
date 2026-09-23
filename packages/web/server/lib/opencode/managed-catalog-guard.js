// A managed launcher (smarty-code) owns the project catalog. In that mode this server creates no
// folders and registers no new projects, whatever the UI shows (#126 item 8). Stock when unset.
export const MANAGED_CATALOG_ENV = 'OPENCHAMBER_MANAGED_CATALOG';

export const isManagedCatalog = (env = process.env) => env?.[MANAGED_CATALOG_ENV] === '1';

export const MANAGED_CATALOG_REFUSAL = 'Projects come from the managed project catalog. This server does not create folders or add projects.';

const refuseUnreadCatalog = async () => { throw new Error('No managed catalog reader'); };

/** Register before the owning routes so a refusal happens before any filesystem or settings change.
 * `isLiveDirectory` checks a directory against the live managed rows and throws when they cannot be
 * read; every managed check then refuses (fail closed). */
export const registerManagedCatalogGuard = (app, {
  env = process.env, readSettingsFromDisk, sanitizeProjects, isLiveDirectory = refuseUnreadCatalog,
}) => {
  const refuse = (res) => res.status(403).json({ error: MANAGED_CATALOG_REFUSAL });
  const refuseWhenManaged = (_req, res, next) => (isManagedCatalog(env) ? refuse(res) : next());

  // POST /api/fs/mkdir decides in its own route: it needs the explicit directory and the chats root.
  app.post('/api/fs/clone', refuseWhenManaged);
  app.post('/api/opencode/directory', refuseWhenManaged);

  // Bookmark edits (rename, color, reorder, remove) stay allowed; a project path not already saved
  // does not. Navigation pointers may only name live rows: lastDirectory directly, activeProjectId
  // through its saved bookmark. Empty or absent pointers pass.
  // Any other non-empty value names no live row and is refused.
  const text = (value) => String(value ?? '').trim();
  app.put('/api/config/settings', async (req, res, next) => {
    if (!isManagedCatalog(env)) return next();
    const body = req.body ?? {};
    const projects = Array.isArray(body.projects) ? body.projects : null;
    const lastDirectory = text(body.lastDirectory);
    const activeProjectId = text(body.activeProjectId);
    if (!projects && !lastDirectory && !activeProjectId) return next();
    try {
      const saved = sanitizeProjects((await readSettingsFromDisk()).projects) || [];
      if (projects) {
        const savedPaths = new Set(saved.map((project) => project.path));
        if ((sanitizeProjects(projects) || []).some((project) => !savedPaths.has(project.path))) return refuse(res);
      }
      if (lastDirectory && !(await isLiveDirectory(lastDirectory))) return refuse(res);
      if (activeProjectId) {
        const bookmark = saved.find((project) => project.id === activeProjectId);
        if (!bookmark || !(await isLiveDirectory(bookmark.path))) return refuse(res);
      }
      return next();
    } catch (error) {
      console.error('[managed-catalog] Failed to check a settings update against the catalog:', error);
      return res.status(503).json({ error: 'Could not check the managed project catalog' });
    }
  });
};
