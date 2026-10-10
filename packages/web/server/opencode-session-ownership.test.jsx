import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { registerOpenCodeProxy } from './lib/opencode/proxy.js';
import { readOrdinaryModel } from '@/lib/opencode/ordinaryModel';
import { mergeBootstrapSessions } from '@/sync/reconnect-recovery';
import { SyncProvider, useSyncRuntime } from '@/sync/sync-context';
import { ModelControls } from '@/components/chat/ModelControls';
import { OrdinaryModelControls } from '@/components/chat/OrdinaryModelControls';
import { ChatColumnSessionContext } from '@/components/chat/chatColumnSession';
import { I18nProvider } from '@/lib/i18n';
import { cohort, expectedRows, listQuery, nativeState, retained, routes, upstreamRows, windowsSettings, withPlatform } from './opencode-session-ownership.fixtures.js';

const listen = app => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});
const close = server => new Promise((resolve, reject) => {
  if (!server) return resolve();
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
});
// Call the real hook-owning component under React's renderer and retain its returned
// element. No hook replacement, module mock, ownership override, or copied branch.
const consume = (rows, id, sdk) => {
  let runtime, element;
  function Seed() {
    runtime = useSyncRuntime();
    const store = runtime.childStores.ensureChild(retained.directory, { bootstrap: false });
    const merged = mergeBootstrapSessions(rows, rows, []);
    store.setState({ session: merged.sessions, sessionTotal: merged.rootCount, sessionListSource: 'authoritative' });
    return <Probe />;
  }
  function Probe() {
    element = ModelControls({});
    // The native branch renders normally. Stock is inspected without mounting its
    // unrelated configuration UI. Full native SSR waits honestly for its catalog.
    return element.type === OrdinaryModelControls ? element : null;
  }
  try {
    const html = renderToStaticMarkup(
      <SyncProvider sdk={sdk} directory={retained.directory}>
        <ChatColumnSessionContext.Provider value={{ sessionId: id, directory: retained.directory }}>
          <I18nProvider><Seed /></I18nProvider>
        </ChatColumnSessionContext.Provider>
      </SyncProvider>,
    );
    return { element, html };
  } finally {
    runtime?.messageLoader.dispose();
    runtime?.childStores.disposeAll();
  }
};

describe('sanitized lists retain native ownership through the real UI consumer', () => {
  let upstream, proxy, windowsUpstream, windowsProxy, sdk;
  const payloads = new Map();
  const windowsPayloads = new Map();
  const seen = [];
  const windowsSeen = [];
  beforeAll(async () => {
    const donor = express();
    for (const route of routes) donor.get(route.slice(4), (req, res) => {
      seen.push({ path: req.path, query: req.query });
      res.setHeader('X-Next-Cursor', '1154');
      res.json(upstreamRows);
    });
    upstream = await listen(donor);
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const isolatedFs = { ...fs, readFileSync: () => JSON.stringify(windowsSettings) };
    const isolatedOs = { ...os, homedir: () => '/fixture/home' };
    const app = express();
    registerOpenCodeProxy(app, {
      fs: isolatedFs, os: isolatedOs, path, OPEN_CODE_READY_GRACE_MS: 0, LONG_REQUEST_TIMEOUT_MS: 1000,
      getRuntime: () => ({ openCodePort: upstream.address().port, openCodeBaseUrl: base,
        isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({}), buildOpenCodeUrl: requestPath => `${base}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxy = await listen(app);
    const proxyBase = `http://127.0.0.1:${proxy.address().port}`;
    sdk = createOpencodeClient({ baseUrl: `${proxyBase}/api` });
    const query = new URLSearchParams(listQuery);
    for (const route of routes) {
      const response = await fetch(`${proxyBase}${route}?${query}`, { signal: AbortSignal.timeout(3000) });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-next-cursor')).toBe('1154');
      const rows = await response.json();
      payloads.set(route, rows);
      console.log('LIST_PAYLOAD', route, JSON.stringify(rows));
    }

    const windowsDonor = express();
    for (const route of routes) windowsDonor.get(route.slice(4), (req, res) => {
      windowsSeen.push({ path: req.path, query: req.query });
      res.setHeader('X-Next-Cursor', '1154');
      res.json(upstreamRows);
    });
    windowsUpstream = await listen(windowsDonor);
    const windowsBase = `http://127.0.0.1:${windowsUpstream.address().port}`;
    withPlatform('win32', () => {
      const windowsApp = express();
      registerOpenCodeProxy(windowsApp, {
        fs: isolatedFs, os: isolatedOs, path, OPEN_CODE_READY_GRACE_MS: 0, LONG_REQUEST_TIMEOUT_MS: 1000,
        getRuntime: () => ({ openCodePort: windowsUpstream.address().port, openCodeBaseUrl: windowsBase,
          isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
        getOpenCodeAuthHeaders: () => ({}), buildOpenCodeUrl: requestPath => `${windowsBase}${requestPath}`,
        ensureOpenCodeApiPrefix: () => {},
      });
      windowsProxy = windowsApp.listen(0, '127.0.0.1');
    });
    await new Promise((resolve, reject) => {
      windowsProxy.once('listening', resolve);
      windowsProxy.once('error', reject);
    });
    const windowsProxyBase = `http://127.0.0.1:${windowsProxy.address().port}`;
    for (const route of routes) {
      const response = await fetch(`${windowsProxyBase}${route}?${query}`, { signal: AbortSignal.timeout(3000) });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-next-cursor')).toBe('1154');
      windowsPayloads.set(route, await response.json());
    }
  });
  afterAll(async () => {
    await close(proxy);
    await close(upstream);
    await close(windowsProxy);
    await close(windowsUpstream);
    console.log('CLOSURE', JSON.stringify({ proxyListening: proxy?.listening ?? false, upstreamListening: upstream?.listening ?? false, windowsProxyListening: windowsProxy?.listening ?? false, windowsUpstreamListening: windowsUpstream?.listening ?? false }));
  });

  it('forwards both real list-route queries', () => {
    expect(seen).toEqual(routes.map(route => ({ path: route.slice(4), query: listQuery })));
  });
  it('keeps both directory-scoped list routes on the generic path in simulated Windows mode', () => {
    expect(windowsSeen).toEqual(routes.map(route => ({ path: route.slice(4), query: listQuery })));
    for (const route of routes) expect(windowsPayloads.get(route)).toEqual(expectedRows);
  });
  for (const route of routes) {
    it(`${route} preserves exactly the public fields and strips diffs, snapshots and extras`, () => {
      expect(payloads.get(route)).toEqual(expectedRows);
    });
    it(`${route}: lawful stock fields and heavy-field stripping remain intact`, () => {
      const rows = payloads.get(route);
      expect(rows.find(row => row.id === 'stock')).toEqual(expectedRows.find(row => row.id === 'stock'));
      for (const row of rows) {
        expect(row.summary).toEqual({ additions: 5, deletions: 3, files: 2 });
        expect(row.revert).toEqual({ messageID: 'message-1154', partID: 'part-1154' });
        expect(Object.hasOwn(row, 'permission')).toBe(false);
        expect(Object.hasOwn(row, 'unlistedExtra')).toBe(false);
      }
    });
    for (const fixture of cohort) {
      it(`${route}: ${fixture.id} reaches its owning parser and ModelControls branch`, () => {
        const rows = payloads.get(route);
        const row = rows.find(item => item.id === fixture.id);
        const parsed = readOrdinaryModel(row);
        const { element, html } = consume(rows, fixture.id, sdk);
        console.log('UI_BRANCH', JSON.stringify({ route, id: fixture.id, branch: element.type.name,
          state: element.props.state, target: element.props.target, html }));
        // Check the actual branch independently of the route's structural assertion.
        if (fixture.branch === 'ordinary') {
          expect(element.type).toBe(OrdinaryModelControls);
          expect(element.props.state).toEqual(fixture.state);
          expect(element.props.target).toEqual({ sessionId: fixture.id, directory: retained.directory });
          expect(parsed).toEqual(fixture.state);
          if (fixture.state.model === null) {
            // SSR has not loaded the target catalog yet; native ownership still selects this pending branch.
            expect(html).toContain('Loading');
            expect(html).not.toContain('Native model 1154');
          } else expect(html).toContain('Loading');
        } else {
          expect(element.type.name).toBe('ConfiguredModelControls');
          expect(parsed).toBeUndefined();
          expect(Object.hasOwn(element.props, 'state')).toBe(false);
        }
      });
    }
    it(`${route}: consumed full native state renders its exact model name and High`, () => {
      const state = readOrdinaryModel(payloads.get(route).find(row => row.id === 'native-full'));
      // Existing OrdinaryModelControls SSR precedent: no target means a read-only label,
      // not a fetched catalog or a writable session. Never supply fallback native state.
      expect(state).toEqual(nativeState);
      const html = renderToStaticMarkup(<I18nProvider><OrdinaryModelControls state={state} /></I18nProvider>);
      expect(html).toContain('title="native-provider / native-model"');
      expect(html).toContain('>Native model 1154</span>');
      expect(html).toContain('>High</span>');
      expect(html).not.toContain('stock-model');
    });
  }
});
