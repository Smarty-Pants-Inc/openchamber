import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { adoptRelayTunnel, deactivateRelayTunnel, isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import type { RelayTunnelClient } from '@/lib/relay/tunnel-client';
import { useGuestActions, useGuestAttachItems, useGuestCommands, useGuestPages, useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { GuestHosts } from '@/components/layout/GuestHosts';
import { getGuestResolver } from './resolve';
import { useGuestActionHostStore, runGuestAction } from './run-action';
import { useGuestResolveHostStore } from './run-command';
import { useGuestBadgeStore } from './badge-store';
import { loadGuestCatalog } from './load-catalog';
import { useGuestsStore } from './store';
import type { InstalledGuest } from './types';

const approvedGuest: InstalledGuest = {
  id: 'approved-guest', name: 'Approved guest', icon: 'window', enabled: true, version: '1.0.0',
  entry: 'index.html', backgroundEntry: 'background.html', pageEntry: 'page.html', attach: 'dialog',
  capabilities: { requested: ['network', 'service'], granted: ['network', 'service'] },
  commands: [{ name: 'guest-command' }],
  actions: [{ id: 'inspect', label: 'Inspect', where: 'message', mode: 'background' }],
};

const seedReadyCatalog = () => {
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([approvedGuest], runtimeKey);
};

afterEach(() => {
  deactivateRelayTunnel();
  useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  useGuestBadgeStore.getState().resetForRuntimeSwitch();
});

describe('fork guest catalog policy', () => {
  test('a ready approved catalog and diagnostics become unsupported synchronously, without a request', async () => {
    seedReadyCatalog();
    useGuestsStore.getState().markFailed(getRuntimeKey(), { method: 'GET', path: '/api/guests', kind: 'http', status: 500 });
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ guests: [approvedGuest] }));
    try {
      const pending = loadGuestCatalog();
      expect(useGuestsStore.getState()).toMatchObject({ status: 'unsupported', guests: [], failure: null, runtimeKey: getRuntimeKey() });
      await pending;
      await Promise.all([loadGuestCatalog(), loadGuestCatalog()]);
      expect(fetch.mock.calls).toHaveLength(0);
      expect(useGuestsStore.getState().status).toBe('unsupported');
    } finally { fetch.mockRestore(); }
  });

  test('switching to an enabled external legacy or relay runtime cannot re-enable catalog fetching', async () => {
    const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 409 }));
    let relayRequests = 0;
    try {
      seedReadyCatalog();
      await loadGuestCatalog();
      switchRuntimeEndpoint({ apiBaseUrl: 'https://enabled-external.example.test', runtimeKey: 'enabled-external' });
      // The runtime switch owns its ordinary URL-auth mint. It is not a guest
      // request; let it settle before measuring the loader's zero-request budget.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetch.mock.calls.every(([input]) => String(input).endsWith('/auth/url-token'))).toBe(true);
      const switchRequests = fetch.mock.calls.length;
      useGuestsStore.getState().resetForRuntimeSwitch(previous.runtimeKey);
      useGuestsStore.getState().replaceCatalog([approvedGuest], previous.runtimeKey);
      useGuestBadgeStore.getState().setBadge(approvedGuest.id, 3);
      await loadGuestCatalog();
      expect(useGuestBadgeStore.getState().countByGuest).toEqual({});
      expect(useGuestsStore.getState()).toMatchObject({ status: 'unsupported', guests: [], runtimeKey: 'enabled-external' });
      expect(fetch.mock.calls).toHaveLength(switchRequests);

      const descriptor = { relayUrl: 'wss://relay.example.test', serverId: 'fixture', hostEncPubJwk: {} };
      const tunnel: RelayTunnelClient = {
        fetch: async () => { relayRequests++; return Response.json({ guests: [approvedGuest] }); },
        openWebSocket: () => { throw new Error('Disabled catalog must not open a relay socket'); },
        getStatus: () => ({ state: 'connected' }), subscribeStatus: () => () => {}, close: () => {},
      };
      adoptRelayTunnel(descriptor, tunnel);
      expect(isRelayModeActive()).toBe(true);
      seedReadyCatalog();
      await loadGuestCatalog();
      expect(useGuestsStore.getState()).toMatchObject({ status: 'unsupported', guests: [], runtimeKey: 'enabled-external' });
      expect(fetch.mock.calls).toHaveLength(switchRequests);
      expect(relayRequests).toBe(0);
      expect(tunnel.getStatus().state).toBe('connected');
    } finally {
      deactivateRelayTunnel();
      switchRuntimeEndpoint(previous);
      await new Promise((resolve) => setTimeout(resolve, 0));
      fetch.mockRestore();
    }
  });

  test('the refreshed application catalog exposes no guest frames, menus or command resolvers', async () => {
    const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
      localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ guests: [approvedGuest] }));
    seedReadyCatalog();
    await loadGuestCatalog();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const reserved = new Set<string>();
    const CatalogConsumers = () => {
      const surfaces = useGuestSurfaces();
      const actions = useGuestActions();
      const commands = useGuestCommands(reserved);
      const pages = useGuestPages();
      const attach = useGuestAttachItems();
      return React.createElement(React.Fragment, null,
        React.createElement('output', null, JSON.stringify({ surfaces, actions, commands, pages, attach })),
        React.createElement(GuestHosts));
    };
    try {
      await act(async () => root.render(React.createElement(CatalogConsumers)));
      expect(container.querySelector('output')?.textContent).toBe(JSON.stringify({ surfaces: [], actions: [], commands: [], pages: [], attach: [] }));
      const action = approvedGuest.actions?.[0];
      if (!action) throw new Error('Fixture action missing');
      // A menu captured before catalog retirement must not start a new frame.
      await act(async () => runGuestAction({ guest: approvedGuest, action, icon: 'window' },
        { kind: 'message', action: action.id, sessionId: 's1', sessionTitle: 'Fixture', directory: '/fixture',
          messageId: 'm1', role: 'assistant', text: 'Fixture' }, (key) => key));
      expect(container.querySelector('iframe')).toBeNull();
      expect(useGuestActionHostStore.getState().requests).toHaveLength(0);
      expect(useGuestResolveHostStore.getState().guestId).toBeNull();
      expect(getGuestResolver(approvedGuest.id)).toBeNull();
      expect(fetch.mock.calls).toHaveLength(0);
      expect(useGuestsStore.getState().status).toBe('unsupported');
    } finally {
      await act(async () => root.unmount());
      fetch.mockRestore();
      await dom.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
