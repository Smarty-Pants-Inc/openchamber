import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { humanAuthClient, useHumanAuth } from '@/lib/human-auth';
import { useHumanSelf, useHumanSelfSubject } from '@/lib/humanSelf';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { resetShareTokensStore, useShareTokensStore } from '@/lib/shareTokens';

// The mounted Connect iPhone page, the real share-token store, runtimeFetch, the runtime auth
// session and the Better Auth client. Only the HTTP answers are synthetic. A code created for one page, one runtime
// session or one signed-in person never appears for another.
// React DOM and the dialog primitives detect the DOM when first loaded, so the DOM exists before they are imported.
const dom = new Window({ url: 'https://ui.example.test/' });
const domKeys = ['HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'ShadowRoot', 'DocumentFragment', 'KeyboardEvent', 'MouseEvent',
  'PointerEvent', 'FocusEvent', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage'] as const;
const domValues = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  ...Object.fromEntries(domKeys.map(key => [key, dom[key]])) };
const previousGlobals = new Map(Object.keys(domValues).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(domValues)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const fetchSpy = spyOn(globalThis, 'fetch');
afterAll(async () => {
  fetchSpy.mockRestore();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ConnectIphonePage } = await import('./ConnectIphonePage');

const API = 'https://runtime-a.example.test';
const CREATE = 'Create my private link';
type Created = { id: string; token: string; createdAt: string };

// The gateway: who is signed in (Better Auth /get-session), the device list, and POSTs held until the test answers.
let signedIn = 'user-a';
let signedOut = 0;
let posts: { resolve: (created: Created) => void }[] = [];
const session = (id: string) => Response.json({ user: { id, name: id, email: `${id}@example.test`, emailVerified: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  session: { id: `s-${id}`, userId: id, token: 't', expiresAt: new Date(Date.now() + 60_000).toISOString() } });

beforeEach(() => {
  signedIn = 'user-a';
  signedOut = 0;
  posts = [];
  configureRuntimeUrlResolver({ apiBaseUrl: API });
  resetShareTokensStore();
  useAuthSessionStore.setState({ state: 'ok' });
  useHumanAuth.setState({ enabled: true });
  useHumanSelf.setState({ subject: undefined });
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname === '/api/auth/get-session') return session(signedIn);
    if (pathname === '/api/auth/sign-out') { signedOut += 1; return Response.json({ success: true }); }
    if (pathname === '/api/config/settings') return Response.json({});
    if (pathname === '/api/me/share-tokens' && request.method === 'GET') return Response.json([]);
    if (pathname === '/api/me/share-tokens' && request.method === 'POST') {
      return new Promise<Response>(resolve => { posts.push({ resolve: created => resolve(Response.json(created, { status: 201 })) }); });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  });
});
afterEach(() => {
  fetchSpy.mockReset();
  configureRuntimeUrlResolver({});
  useHumanAuth.setState({ enabled: false });
  useHumanSelf.setState({ subject: undefined });
  useAuthSessionStore.setState({ state: 'ok' });
  resetShareTokensStore();
});

const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); });
// The app reads the signed-in person through this hook; it shares the page's root so the page stays mounted.
const Self = () => { useHumanSelfSubject(); return null; };
const mount = async () => {
  // The global document is happy-dom's (installed above), typed by the DOM library React DOM renders into.
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider><Self /><ConnectIphonePage /></I18nProvider>));
  await settle();
  const unmount = async () => { await act(async () => root.unmount()); container.remove(); };
  return { container, unmount };
};
type Container = Awaited<ReturnType<typeof mount>>['container'];
const createButton = (container: Container) =>
  Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(CREATE));
const clickCreate = async (container: Container) => {
  const create = createButton(container);
  expect(create).toBeDefined();
  await act(async () => { create?.click(); });
  await settle();
};
const codeInput = (container: Container) => container.querySelector('[data-share-code] input');
const answer = async (index: number, created: Created) => { await act(async () => posts[index]?.resolve(created)); await settle(); };
const code = (id: string): Created => ({ id, token: `secret-${id}`, createdAt: '2026-10-10T09:00:00.000Z' });

// Every mounted page is unmounted even when an assertion fails, so a failure cannot leak a root into later tests.
const withPage = async (run: (page: Awaited<ReturnType<typeof mount>>) => Promise<void>) => {
  const page = await mount();
  try { await run(page); } finally { await page.unmount(); }
};
const codeValue = (container: Container) => codeInput(container)?.getAttribute('value') ?? null;
const forgotten = (container: Container, secret: string) => {
  expect(container.querySelectorAll('[data-share-code] input').length).toBe(0);
  expect(container.innerHTML).not.toContain(secret);
  expect(JSON.stringify(useShareTokensStore.getState())).not.toContain(secret);
  expect(createButton(container)).toBeDefined();
};

test('an ordinary code shows once created and stays until the page closes', async () => {
  await withPage(async page => {
    await clickCreate(page.container);
    expect(posts).toHaveLength(1);
    await answer(0, code('one'));
    expect(codeValue(page.container)).toBe('secret-one');
    await settle();
    expect(codeValue(page.container)).toBe('secret-one');
  });
  expect(JSON.stringify(useShareTokensStore.getState())).not.toContain('secret-one');
});

for (const order of ['answered before the page reopens', 'answered after the page reopens'] as const) {
  test(`a code requested on a closed page and ${order} never shows on the reopened page`, async () => {
    await withPage(async first => {
      await clickCreate(first.container);
      expect(posts).toHaveLength(1);
    });
    if (order === 'answered before the page reopens') await answer(0, code('late'));
    await withPage(async second => {
      if (order === 'answered after the page reopens') await answer(0, code('late'));
      forgotten(second.container, 'secret-late');
    });
  });
}

test('after one person signs out and another signs in, the first person\'s late code never shows; the new person\'s does', async () => {
  await withPage(async page => {
    expect(useHumanSelf.getState().subject).toBe('user-a');
    await clickCreate(page.container);
    expect(posts).toHaveLength(1);
    // Sign out as the account menu does: the Better Auth sign-out request, then the app waits for a new sign-in.
    await act(async () => {
      const result = await humanAuthClient().signOut();
      expect(result.error).toBeNull();
      useAuthSessionStore.getState().markReauthenticating();
    });
    expect(signedOut).toBe(1);
    // Another person signs in. The verified sign-in renews the runtime credentials, and the signed-in person is read
    // fresh from the Better Auth session (as after the sign-in page returns), while this page stays open.
    signedIn = 'user-b';
    await act(async () => {
      useAuthSessionStore.getState().markAuthenticated();
      useHumanSelf.setState({ subject: undefined });
    });
    await settle();
    expect(useHumanSelf.getState().subject).toBe('user-b');
    expect(useAuthSessionStore.getState().state).toBe('ok');
    await answer(0, code('for-a'));
    forgotten(page.container, 'secret-for-a');
    await clickCreate(page.container);
    expect(posts).toHaveLength(2);
    await answer(1, code('for-b'));
    expect(codeValue(page.container)).toBe('secret-for-b');
  });
});

test('a code answered while the person is signing in again never shows', async () => {
  await withPage(async page => {
    await clickCreate(page.container);
    await act(async () => useAuthSessionStore.getState().markReauthenticating());
    await answer(0, code('reauth'));
    expect(page.container.querySelectorAll('[data-share-code] input').length).toBe(0);
    expect(page.container.innerHTML).not.toContain('secret-reauth');
    expect(JSON.stringify(useShareTokensStore.getState())).not.toContain('secret-reauth');
  });
});
