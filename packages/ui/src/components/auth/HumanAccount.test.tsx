import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { configureRuntimeUrlResolver } from '../../lib/runtime-url';
import { signInWithGoogle, useHumanAuth } from '../../lib/human-auth';

const signInBody = z.object({ provider: z.literal('google'), disableRedirect: z.boolean(), callbackURL: z.string() });

// Actual Better Auth client and product runtime modules; only the HTTP response is synthetic.
test('delayed Google sign-in cannot navigate after runtime switch; current runtime can navigate', async () => {
  const originalWindow = globalThis.window;
  const fetchSpy = spyOn(globalThis, 'fetch');
  const window = new Window({ url: 'https://ui.example.test/' });
  Object.assign(globalThis, { window });
  const requests: { url: string; body: z.infer<typeof signInBody> }[] = [];
  const popup = spyOn(window, 'open');
  try {
    for (const mode of ['switched', 'returned', 'current']) {
      const stale = mode !== 'current';
      window.location.href = 'https://ui.example.test/';
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-a.example.test' });
      let release!: () => void, submitted!: () => void;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { submitted = resolve; });
      fetchSpy.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const url = request.url;
        const body = signInBody.parse(await request.json());
        requests.push({ url, body });
        submitted(); await paused;
        return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', redirect: !body.disableRedirect });
      });
      const pending = signInWithGoogle();
      await started;
      if (stale) configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-b.example.test' });
      if (mode === 'returned') configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-a.example.test' });
      release(); await pending;
      expect(window.location.origin).toBe(stale ? 'https://ui.example.test' : 'https://accounts.google.com');
    }
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url).toBe('https://runtime-a.example.test/api/auth/sign-in/social');
      expect(request.body.provider).toBe('google');
      expect(request.body.disableRedirect).toBe(true);
      // smarty-code#1489: Google returns to the page the person was on (in the app's scope), in the same window, so a
      // home-screen app signs itself in rather than a Safari tab.
      expect(request.body.callbackURL).toBe('https://ui.example.test/');
    }
    expect(popup).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    Object.assign(globalThis, { window: originalWindow });
    configureRuntimeUrlResolver({});
    await window.happyDOM.close();
  }
});

// smarty-code#538: the account moved from above the composer to a top-bar avatar menu.
// React DOM and Base UI detect the DOM when first loaded, so the DOM exists before they are imported.
const dom = new Window({ url: 'https://ui.example.test/' });
const domKeys = ['HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'ShadowRoot', 'DocumentFragment', 'KeyboardEvent', 'MouseEvent',
  'PointerEvent', 'FocusEvent', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const domValues = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  ...Object.fromEntries(domKeys.map(key => [key, (dom as unknown as Record<string, unknown>)[key]])) };
const previousGlobals = new Map(Object.keys(domValues).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(domValues)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../lib/i18n');
const { DisplayNameChoice } = await import('../chat/composer/ui/DisplayNameChoice');
const { HumanAccount } = await import('./HumanAccount');

const user = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.org', image: null };

async function withSession(run: (requests: string[]) => Promise<void>) {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime-a.example.test' });
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    requests.push(url);
    if (url.endsWith('/get-session')) return Response.json({ session: { id: 's1', userId: 'u1' }, user });
    return Response.json({ success: true });
  });
  try { await run(requests); } finally {
    fetchSpy.mockRestore();
    configureRuntimeUrlResolver({});
    useHumanAuth.setState({ enabled: false });
  }
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
const mount = async (node: React.ReactNode) => {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
  await settle();
  return { container, root };
};

test('the composer no longer renders the account when human auth is on', () => withSession(async requests => {
  useHumanAuth.setState({ enabled: true });
  const { container, root } = await mount(<DisplayNameChoice />);
  expect(container.innerHTML).toBe('');
  expect(requests).toHaveLength(0);
  await act(async () => root.unmount());
}));

test('avatar menu shows name, email, organization and signs out', () => withSession(async requests => {
  const { container, root } = await mount(<HumanAccount />);
  const trigger = container.querySelector('button[aria-label="Account"]') as unknown as HTMLButtonElement;
  expect(trigger.textContent).toBe('AL');
  await act(async () => { trigger.click(); });
  await settle();
  const menu = dom.document.body.textContent || '';
  for (const text of ['Ada Lovelace', 'ada@example.org', 'Organization', 'Smarty Pants', 'Edit profile', 'Sign out other devices', 'Sign out']) {
    expect(menu).toContain(text);
  }
  const signOut = [...dom.document.querySelectorAll('[role="menuitem"]')]
    .find(item => item.textContent === 'Sign out') as unknown as HTMLElement;
  await act(async () => { signOut.click(); });
  await settle();
  expect(requests.some(url => url.endsWith('/api/auth/sign-out'))).toBe(true);
  await act(async () => root.unmount());
}));
