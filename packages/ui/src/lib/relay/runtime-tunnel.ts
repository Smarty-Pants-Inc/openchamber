// Module-level singleton holding the active relay tunnel client, if the runtime
// is in relay mode. Kept in its own module so runtime-switch, runtime-fetch,
// runtime-url, and the event pipeline can all read it without an import cycle
// (runtime-switch <-> runtime-url).

import { createRelayTunnelClient, type RelayTunnelClient } from './tunnel-client';

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

export type RetainedRelayTunnel = {
  client: RelayTunnelClient;
  release: () => void;
};

let activeTunnel: RelayTunnelClient | null = null;
let activeDescriptor: RelayRuntimeDescriptor | null = null;

const retainedTunnelCounts = new Map<RelayTunnelClient, number>();

const closeRetiredTunnel = (tunnel: RelayTunnelClient | null): void => {
  if (tunnel && tunnel !== activeTunnel && !retainedTunnelCounts.has(tunnel)) {
    tunnel.close();
  }
};

const retireActiveTunnel = (): void => {
  const tunnel = activeTunnel;
  activeTunnel = null;
  activeDescriptor = null;
  closeRetiredTunnel(tunnel);
};

const descriptorsEqual = (a: RelayRuntimeDescriptor, b: RelayRuntimeDescriptor): boolean =>
  a.relayUrl === b.relayUrl &&
  a.serverId === b.serverId &&
  a.grant === b.grant &&
  JSON.stringify(a.hostEncPubJwk) === JSON.stringify(b.hostEncPubJwk);

export const getActiveRelayTunnel = (): RelayTunnelClient | null => activeTunnel;
export const getActiveRelayDescriptor = (): Omit<RelayRuntimeDescriptor, 'grant'> | null => {
  if (!activeTunnel || !activeDescriptor) return null;
  return {
    relayUrl: activeDescriptor.relayUrl,
    serverId: activeDescriptor.serverId,
    hostEncPubJwk: { ...activeDescriptor.hostEncPubJwk },
  };
};

export const isRelayModeActive = (): boolean => activeTunnel !== null;

/**
 * Keeps the current relay alive for a mutation that must compensate against
 * the same remote runtime after a subsequent endpoint switch.
 */
export const retainActiveRelayTunnel = (): RetainedRelayTunnel | null => {
  const client = activeTunnel;
  if (!client) return null;
  retainedTunnelCounts.set(client, (retainedTunnelCounts.get(client) ?? 0) + 1);
  let released = false;
  return {
    client,
    release: () => {
      if (released) return;
      released = true;
      const count = retainedTunnelCounts.get(client) ?? 0;
      if (count <= 1) retainedTunnelCounts.delete(client);
      else retainedTunnelCounts.set(client, count - 1);
      closeRetiredTunnel(client);
    },
  };
};

/**
 * Activates relay mode with the given descriptor, replacing any previous tunnel.
 * Reuses the existing client when the descriptor is unchanged so a redundant
 * runtime switch does not tear down a live tunnel.
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): RelayTunnelClient => {
  if (activeTunnel && activeDescriptor && descriptorsEqual(activeDescriptor, descriptor)) {
    return activeTunnel;
  }
  retireActiveTunnel();
  activeDescriptor = descriptor;
  activeTunnel = createRelayTunnelClient(descriptor);
  return activeTunnel;
}

/**
 * Adopts an ALREADY-OPEN tunnel client (e.g. the connect flow's probe tunnel)
 * as the active runtime tunnel, so the immediately following
 * `activateRelayTunnel` with an equal descriptor reuses it instead of paying a
 * second WebSocket connect + E2EE handshake. Replaces any previous tunnel.
 */
export const adoptRelayTunnel = (descriptor: RelayRuntimeDescriptor, client: RelayTunnelClient): void => {
  if (activeTunnel === client) return;
  retireActiveTunnel();
  activeDescriptor = descriptor;
  activeTunnel = client;
}

export const deactivateRelayTunnel = (): void => {
  retireActiveTunnel();
}
