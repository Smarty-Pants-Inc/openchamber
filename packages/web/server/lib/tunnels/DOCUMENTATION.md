# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for an operator-started tunnel (server launch options), including provider registry/service wiring and managed remote token config lifecycle. There is no HTTP tunnel control: `/api/openchamber/tunnel/*` was removed (smarty-code#1398), so a signed-in member cannot start, stop or inspect tunnels.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/server/lib/tunnels/registry.js`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime.
- `packages/web/server/lib/tunnels/install-help.js`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/start.js`: starts a normalized tunnel request at launch (no routes).
- `packages/web/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.

## Public exports (start.js)
- `createTunnelStartRuntime(dependencies)`: creates the launch-time tunnel starter.
- Returned API:
  - `startTunnelWithNormalizedRequest(request)`
