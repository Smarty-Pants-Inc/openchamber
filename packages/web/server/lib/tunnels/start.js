// Operator-started tunnels only (`openchamber serve` tunnel options at startup).
// There are no HTTP tunnel routes: /api/openchamber/tunnel/* was removed so a
// signed-in member cannot start, stop or inspect tunnels (smarty-code#1398).
export const createTunnelStartRuntime = (dependencies) => {
  const {
    tunnelService,
    upsertManagedRemoteTunnelToken,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
  } = dependencies;

  const startTunnelWithNormalizedRequest = async ({
    provider,
    mode,
    intent,
    hostname,
    token,
    configPath,
    selectedPresetId,
    selectedPresetName,
  }) => {
    if (provider === TUNNEL_PROVIDER_CLOUDFLARE && mode === TUNNEL_MODE_MANAGED_REMOTE && token && hostname) {
      await upsertManagedRemoteTunnelToken({
        id: selectedPresetId || hostname,
        name: selectedPresetName || hostname,
        hostname,
        token,
      });
    }

    const result = await tunnelService.start({
      provider,
      mode,
      intent,
      configPath,
      token,
      hostname,
    });

    console.log(`Tunnel active (${result.provider}): ${result.publicUrl}`);
    return {
      publicUrl: result.publicUrl,
      mode: result.activeMode,
      provider: result.provider,
      providerMetadata: result.providerMetadata,
    };
  };

  return {
    startTunnelWithNormalizedRequest,
  };
};
