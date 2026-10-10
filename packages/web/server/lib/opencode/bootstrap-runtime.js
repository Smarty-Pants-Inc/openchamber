import { registerHumanSidebarViewRoutes } from '../ui-auth/human-sidebar-view.js';
import { registerBillingRoleRoute } from '../billing-role/billing-role.js';
import { registerPreviewServeRoute } from '../fs/preview-capability.js';
import { applicationAuthority, browserRequestAllowed, configureApplicationHosts } from '../security/browser-origin.js';
import { isShareRequest } from './share-route.js';

export const createBootstrapRuntime = (dependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerOpenChamberRoutes,
    registerAgentToolRoutes = () => {},
    express,
  } = dependencies;

  const setupBaseRoutes = (app, options) => {
    const {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerPort,
      getTunnelUrl,
      verboseRequestLogs,
      uiPassword,
      humanAuth = null,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      sayTTSCapability,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      fetchFreeZenModels,
      getCachedZenModels,
      setAutoAcceptSession,
      agentToolRuntime,
    } = options;

    const uiAuthController = createUiAuth({
      password: uiPassword,
      readSettingsFromDiskMigrated,
      clientAuthController: remoteClientAuthRuntime,
      humanAuth,
    });
    configureApplicationHosts(async () => {
      const settings = await Promise.resolve(readSettingsFromDiskMigrated?.()).catch(() => undefined);
      return [settings?.publicOrigin, getTunnelUrl?.(), ...(process.env.OPENCHAMBER_ALLOWED_HOSTS ?? '').split(',')]
        .flatMap((value) => { try { return value ? [String(value).includes('://') ? new URL(String(value)).host : String(value).trim()] : []; } catch { return []; } });
    });
    if (humanAuth) {
      // Human HTTP requests need an application Host before any capability, OAuth handler or downstream route.
      app.use((req, res, next) => {
        void (async () => {
          if (!await applicationAuthority(req)) return res.status(403).json({ error: 'Requests require an application host' });
          return next();
        })().catch(next);
      });
    }
    // Preview capabilities precede origin/session checks. Human mode still requires a bound Host above;
    // passwordless mode retains its capability-only preview exception.
    registerPreviewServeRoute(app);
    app.use('/api/config/sidebar-view', (_req, res, next) => {
      res.setHeader('Cache-Control', 'private, no-store'); next();
    });
    if (humanAuth) {
      // Protect application mutations too, including status routes registered below.
      app.use((req, res, next) => {
        const origin = req.headers.origin;
        // smarty-dev#799: the iPhone Shortcut is no browser and sends no Origin; a browser's share still needs ours.
        if ((origin && origin !== humanAuth.auth.options.baseURL)
          || (!origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isShareRequest(req))) {
          return res.status(403).json({ error: 'Human authentication requires the configured application origin' });
        }
        return next();
      });
      // Better Auth must receive the original stream before express.json consumes it.
      app.all('/api/auth/*splat', (req, res, next) => {
        if (req.path === '/api/auth/reset') return next('route'); // Retained legacy refusal route.
        const scope = tunnelAuthController.classifyRequestScope(req);
        return scope === 'tunnel' || scope === 'unknown-public'
          ? tunnelAuthController.requireTunnelSession(req, res, next) : next();
      }, humanAuth.handler);
      // smarty-net#136 L3: whether the signed-in person owns this Node's org (the owner-only billing links).
      registerBillingRoleRoute(app, humanAuth);
    }
    // smarty-code#391: the passwordless mode's browser-origin rule (lib/security/browser-origin.js), for every mutation
    // before the status and API routes; the WebSocket listeners apply the same rule to their upgrades.
    if (!uiAuthController.enabled) {
      // Every request (reads included) needs an application host; a mutation also needs the application origin. The
      // preview capability is registered above, before this: its capability is its only credential.
      app.use((req, res, next) => {
        void (async () => {
          if (!await applicationAuthority(req)) return res.status(403).json({ error: 'Requests require an application host' });
          if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || await browserRequestAllowed(req)) return next();
          return res.status(403).json({ error: 'Application mutations require the application origin' });
        })().catch(next);
      });
    }
    if (uiAuthController.enabled) {
      console.log(humanAuth ? 'Google human authentication enabled' : 'UI password protection enabled for browser sessions');
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerId,
      getServerPort,
      getTunnelUrl,
      tunnelAuthController,
      uiAuthController,
    });

    registerCommonRequestMiddleware(app, { express, verboseRequestLogs });

    registerAgentToolRoutes(app, { express, agentToolRuntime });

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
    });

    registerHumanSidebarViewRoutes(app, { express, humanAuth });

    registerTtsRoutes(app, { sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      authorizeUiSession: uiAuthController.authorizeUiSession,
      humanMode: uiAuthController.humanMode === true,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getSessionAttentionSnapshot: sessionRuntime.getSessionAttentionSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      getSessionAttentionState: sessionRuntime.getSessionAttentionState,
      markSessionViewed: sessionRuntime.markSessionViewed,
      markSessionUnviewed: sessionRuntime.markSessionUnviewed,
      markUserMessageSent: sessionRuntime.markUserMessageSent,
      setPushInitialized,
      setAutoAcceptSession,
    });

    registerOpenChamberRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      readSettingsFromDiskMigrated,
      fetchFreeZenModels,
      getCachedZenModels,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
