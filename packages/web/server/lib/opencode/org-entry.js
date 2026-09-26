// An organization's entry URL (code.smartypants.ai/smartypants) opens the app.
// ponytail: MVP 1 serves one organization, so its path redirects to the app at `/`. The client then runs at one URL,
// and sign-in returns there. Per-organization routing (smarty-code#305) replaces this list.
export const ORG_ENTRY_SLUGS = Object.freeze(['smartypants']);

export const registerOrgEntryRoutes = (app, slugs = ORG_ENTRY_SLUGS) => {
  for (const slug of slugs) {
    app.get([`/${slug}`, `/${slug}/`], (req, res) => {
      const query = req.originalUrl.indexOf('?');
      res.set('Cache-Control', 'no-store');
      res.redirect(302, query === -1 ? '/' : `/${req.originalUrl.slice(query)}`);
    });
  }
};
