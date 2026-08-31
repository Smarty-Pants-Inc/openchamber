import { describe, expect, mock, test } from 'bun:test';

const closedTunnelIds: string[] = [];
let nextTunnelId = 0;

mock.module('./tunnel-client', () => ({
  createRelayTunnelClient: () => {
    const id = `tunnel-${++nextTunnelId}`;
    return {
      fetch: async () => new Response(null, { status: 204 }),
      openWebSocket: () => {
        throw new Error('not used by runtime tunnel ownership tests');
      },
      getStatus: () => ({ state: 'connected' }),
      subscribeStatus: () => () => {},
      close: () => closedTunnelIds.push(id),
    };
  },
}));

describe('runtime relay tunnel retention', () => {
  test('keeps a bound relay open until its operation releases it after a switch', async () => {
    // Dynamic import applies the test-only tunnel factory before singleton initialization.
    const {
      activateRelayTunnel,
      deactivateRelayTunnel,
      retainActiveRelayTunnel,
    } = await import('./runtime-tunnel');
    const descriptor = (serverId: string) => ({
      relayUrl: `wss://${serverId}.example`,
      serverId,
      hostEncPubJwk: { kty: 'EC' } as JsonWebKey,
    });

    deactivateRelayTunnel();
    closedTunnelIds.length = 0;
    activateRelayTunnel(descriptor('first'));
    const retained = retainActiveRelayTunnel();
    expect(retained).not.toBeNull();

    activateRelayTunnel(descriptor('second'));
    expect(closedTunnelIds).toEqual([]);

    retained?.release();
    expect(closedTunnelIds).toEqual(['tunnel-1']);

    deactivateRelayTunnel();
    expect(closedTunnelIds).toEqual(['tunnel-1', 'tunnel-2']);
  });
});
