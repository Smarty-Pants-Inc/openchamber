const UNSUPPORTED = 'Permission auto-accept is unsupported in this fork';

// Hard-disabled, not default-off. Keep the old entry points inert for scheduled
// tasks and older callers without reading or resetting their stored policies.
export function createPermissionAutoAcceptRuntime(_dependencies) {
  const snapshot = () => ({ supported: false, sessions: {}, revision: 0 });
  return {
    snapshot,
    load: async () => snapshot(),
    setSessionPolicy: async () => {
      throw Object.assign(new Error(UNSUPPORTED), { status: 501 });
    },
    isSessionAutoAccepting: async () => false,
    processPermission: async () => false,
    reconcilePending: async () => {},
    start: () => () => {},
  };
}

export function registerPermissionAutoAcceptRoutes(app, _runtime) {
  // Own every method and descendant before the generic OpenCode proxy. No
  // settings value, environment flag, or injected evaluator can enable replies.
  app.use('/api/permission-auto-accept', (_req, res) => {
    res.status(501).json({ supported: false, error: UNSUPPORTED });
  });
}
