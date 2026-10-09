import { afterAll, beforeEach, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { OrgAgent } from '@/lib/orgAgent';
import type { SmartiesResult, SmartyFeed } from '@/lib/smarties';
import type { FeedServices } from './FeedView';

// smarty-code#1192: the Smarty page's header offers a voice call with the viewer's own org agent (GET /me/org-agent),
// through the shared Voice call control and the gateway's per-session voice status, and a read-only session's banner
// offers the same control. The gateway is faked at its HTTP routes; the control, the client and the stores are real.
const paul: SmartiesResult = { state: 'ready', me: 'paul', smarties: [
  { id: 'paul', label: 'Paul’s Smarty', own: true, writable: true }, { id: 'kate', label: 'Kate’s Smarty', own: false, writable: false }] };
const feed = { blocks: [{ id: 'b1', author: 'org', at: '11:55 PM ET', text: 'Good evening, Paul.' }], offset: 10 } satisfies SmartyFeed;
const orgSession = { id: 'org-1', slug: 'org', projectID: 'p', directory: '/home/paul/smarty', title: 'Org', version: '1',
  time: { created: 1, updated: 1 } } satisfies Session;
const agent: OrgAgent = { sessionId: 'org-1', herdrAgent: 'org', name: 'Paul', live: true };

type Voice = { available: boolean; reason?: string };
let voice: Voice = { available: true };
const voiceAsked: string[] = [];
type Health = { healthy: true; version: string; capabilities: { sessionVoice: 1; sessionVoiceStatus: 1 } };
type Inbox = { person: string; items: [] };
const json = (body: Voice | Health | Inbox, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const win = new Window({ url: 'https://code.example.test' });
Object.defineProperty(win, 'isSecureContext', { value: true });
Object.assign(win, { RTCPeerConnection: class {}, AudioContext: class {} });
Object.defineProperty(win.navigator, 'mediaDevices', { value: {} });
const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: win.HTMLElement,
  Element: win.Element, Node: win.Node, DocumentFragment: win.DocumentFragment, Event: win.Event, MouseEvent: win.MouseEvent, PointerEvent: win.PointerEvent,
  customElements: win.customElements, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver, getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
  // The gateway: health advertises per-session voice status; /api/session/:id/voice answers `voice`; the inbox is empty.
  fetch: async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://code.example.test');
    if (url.pathname.endsWith('/global/health')) return json({ healthy: true, version: '1', capabilities: { sessionVoice: 1, sessionVoiceStatus: 1 } });
    const asked = /\/api\/session\/([^/]+)\/voice$/.exec(url.pathname);
    if (asked) { voiceAsked.push(`${decodeURIComponent(asked[1]!)}@${url.searchParams.get('directory')}`); return json(voice); }
    return json({ person: 'paul', items: [] });
  } };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
// The transcript uses the chat's Markdown renderer, whose modules use Vite transforms Bun lacks.
await plugin({ name: 'feed-voice-vite-transforms', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: "export default 'data:text/javascript,'", loader: 'js' }));
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, async ({ path }) => {
    const logos = Object.fromEntries(readdirSync(fileURLToPath(new URL('../../../assets/provider-logos/', import.meta.url)))
      .filter((name) => name.endsWith('.svg')).map((name) => [`../assets/provider-logos/${name}`, `/assets/provider-logos/${name}`]));
    const source = await readFile(path, 'utf8');
    return { contents: source.replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });
const { FeedView } = await import('./FeedView');
const { useFeedStore, ensureSmartiesLoaded } = await import('./feedStore');
const { FleetViewOnlyBanner } = await import('@/components/chat/FleetViewOnlyBanner');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const { useInboxStore } = await import('@/lib/smartyInbox');

afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

let orgAgent: () => Promise<OrgAgent | null> = async () => agent;
const services: Partial<FeedServices> = {
  loadFeed: async () => feed, openStream: () => ({ close: () => undefined }), send: async () => undefined,
  loadOrgAgent: () => orgAgent(), Text: ({ content }) => <p>{content}</p>,
};
// SAFETY: PiVoiceControl reads only `runtime.isVSCode` from the runtime context.
const runtime = { runtime: { platform: 'web', isVSCode: false, isDesktop: false } } as RuntimeAPIs;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
const mount = async (node: React.ReactNode) => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<I18nProvider><RuntimeAPIContext.Provider value={runtime}>{node}</RuntimeAPIContext.Provider></I18nProvider>));
  await settle();
  return { host, unmount: () => act(async () => root.unmount()) };
};
const headerVoice = (host: Element) => Array.from(host.querySelectorAll('header button')).find(b => b.textContent?.trim() === 'Voice call');

beforeEach(async () => {
  localStorage.clear();
  useFeedStore.setState({ view: 'smarty', selectedId: null, pageOpen: true, smarties: { state: 'loading' }, drafts: {}, failedSends: {}, pendingSends: {} });
  await ensureSmartiesLoaded(async () => paul, true);
  useInboxStore.setState({ available: true, openCount: 0 });
  useGlobalSessionsStore.getState().applySnapshot([orgSession], [], 'ready');
  orgAgent = async () => agent; voice = { available: true }; voiceAsked.length = 0;
});

for (const compact of [false, true]) {
  const surface = compact ? 'phone' : 'desktop';
  test(`${surface}: the own Smarty's header offers a voice call with the viewer's org agent session`, async () => {
    const { host, unmount } = await mount(<FeedView compact={compact} services={services} />);
    const control = headerVoice(host);
    expect(control).toBeDefined();
    expect(control!.hasAttribute('disabled')).toBe(false);
    expect(control!.getAttribute('aria-label')).toBe('Start a voice call with this session');
    // The status was read for the org agent's session, in the directory the fleet session list gives it.
    expect(voiceAsked).toContain('org-1@/home/paul/smarty');
    await unmount();
  });
}

test('a viewer with no org agent gets no voice control, and no status is read', async () => {
  orgAgent = async () => null;
  const { host, unmount } = await mount(<FeedView services={services} />);
  expect(host.querySelector('h1')?.textContent).toBe('Paul’s Smarty');
  expect(headerVoice(host)).toBeUndefined();
  expect(voiceAsked).toEqual([]);
  await unmount();
});

test('the gateway\'s "no" shows the disabled chip with its plain reason, not nothing', async () => {
  voice = { available: false, reason: 'This session is view-only here.' };
  const { host, unmount } = await mount(<FeedView services={services} />);
  const control = headerVoice(host);
  expect(control?.hasAttribute('disabled')).toBe(true);
  expect(control?.getAttribute('aria-label')).toBe('Voice call. This session is view-only here.');
  await unmount();
});

test('another person\'s Smarty shows no voice control (the call is with the viewer\'s own org agent)', async () => {
  useFeedStore.getState().selectSmarty('kate');
  const { host, unmount } = await mount(<FeedView services={services} />);
  expect(host.querySelector('h1')?.textContent).toBe('Kate’s Smarty');
  expect(headerVoice(host)).toBeUndefined();
  await unmount();
});

test('a read-only session\'s banner shows the Voice call when the gateway says voice is available', async () => {
  const { host, unmount } = await mount(<FleetViewOnlyBanner voice={{ sessionId: 'org-1', directory: '/home/paul/smarty' }} />);
  const control = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Voice call');
  expect(control?.hasAttribute('disabled')).toBe(false);
  expect(voiceAsked).toContain('org-1@/home/paul/smarty');
  await unmount();
});

test('a read-only session\'s banner shows the disabled chip with the gateway\'s reason when it says no', async () => {
  voice = { available: false, reason: 'This session is view-only here.' };
  const { host, unmount } = await mount(<FleetViewOnlyBanner voice={{ sessionId: 'org-1', directory: '/home/paul/smarty' }} />);
  const control = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Voice call');
  expect(control?.hasAttribute('disabled')).toBe(true);
  expect(control?.getAttribute('aria-label')).toBe('Voice call. This session is view-only here.');
  await unmount();
});
