import { printTunnelWarning } from '../cloudflare-tunnel.js';
import { createTunnelService } from '../tunnels/index.js';
import { createTunnelStartRuntime } from '../tunnels/start.js';

export const createTunnelWiringRuntime = (dependencies) => {
  const {
    tunnelProviderRegistry,
    upsertManagedRemoteTunnelToken,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    getActiveTunnelController,
    setActiveTunnelController,
  } = dependencies;

  const initialize = (initialPort) => {
    let activePort = initialPort;

    const tunnelService = createTunnelService({
      registry: tunnelProviderRegistry,
      getController: getActiveTunnelController,
      setController: setActiveTunnelController,
      getActivePort: () => activePort,
      onQuickTunnelWarning: () => {
        printTunnelWarning();
      },
    });

    const tunnelStartRuntime = createTunnelStartRuntime({
      tunnelService,
      upsertManagedRemoteTunnelToken,
      TUNNEL_MODE_MANAGED_REMOTE,
      TUNNEL_PROVIDER_CLOUDFLARE,
    });

    return {
      tunnelService,
      startTunnelWithNormalizedRequest: (...args) => tunnelStartRuntime.startTunnelWithNormalizedRequest(...args),
      getActivePort: () => activePort,
      setActivePort: (value) => {
        activePort = value;
      },
    };
  };

  return {
    initialize,
  };
};
