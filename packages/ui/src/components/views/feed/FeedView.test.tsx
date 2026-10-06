import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { OrgAgent } from '@/lib/smartyOrgAgent';
import type { FeedReply, FeedServices } from './FeedView';

// smarty-code#1407: the Feed page against a fake gateway /api/me/org-agent: a 404 no_org_agent says no Smarty is set
// up, any other failure is an error (never "none"), and the reply box sends to the org agent's own session.
type GatewayBody = OrgAgent | { error: string };
const json = (body: GatewayBody, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const kate: OrgAgent = { sessionId: 'ses_kate_smarty', herdrAgent: 'kate-smarty', name: 'Smarty', live: true };
let orgAgentResponse: () => Response = () => json(kate);
const requests: string[] = [];
const fetcher = async (url: string) => { requests.push(url); return orgAgentResponse(); };
const sent: FeedReply[] = [];

const { FeedView } = await import('./FeedView');
const { readFeedDraft, useFeedStore } = await import('./feedStore');
const { loadOrgAgent } = await import('@/lib/smartyOrgAgent');
const { I18nProvider } = await import('@/lib/i18n');
const services: Partial<FeedServices> = {
  loadOrgAgent: () => loadOrgAgent(fetcher),
  send: async (reply) => { sent.push(reply); },
  Conversation: ({ agent }) => <p data-conversation={agent.sessionId}>{agent.name}</p>,
};
const View = () => <I18nProvider><FeedView onClose={() => undefined} services={services} /></I18nProvider>;

const win = new Window({ url: 'http://localhost' });
const values = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: win.HTMLElement,
  Element: win.Element };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});


const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
const mount = async () => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<View />)); await settle();
  return { host, root };
};
// happy-dom's keydown does not reach React's root listener here (a click does): the handler is called as React would,
// as InboxView.test.tsx does for its textarea.
const pressEnter = (target: Element, shiftKey: boolean) => act(async () => {
  const props = Object.entries(target).find(([key]) => key.startsWith('__reactProps$'))?.[1];
  props?.onKeyDown({ key: 'Enter', shiftKey, preventDefault: () => undefined, nativeEvent: { isComposing: false } });
});

test('a person without an org agent sees that no Smarty is set up yet', async () => {
  orgAgentResponse = () => json({ error: 'no_org_agent' }, 404);
  const { host, root } = await mount();
  expect(requests.at(-1)).toBe('/api/me/org-agent');
  expect(host.textContent).toContain('No Smarty is set up for you yet.');
  expect(host.querySelector('[data-conversation]')).toBeNull();
  expect(host.querySelector('textarea')).toBeNull();
  await act(async () => root.unmount());
});

test('a 404 that is not the gateway answer is an error, not "no Smarty"', async () => {
  orgAgentResponse = () => new Response('Not Found', { status: 404 });
  const { host, root } = await mount();
  expect(host.textContent).not.toContain('No Smarty is set up for you yet.');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test('the page shows the org agent conversation and sends a reply to its sessionId', async () => {
  orgAgentResponse = () => json(kate);
  const { host, root } = await mount();
  expect(host.querySelector('[data-conversation]')?.getAttribute('data-conversation')).toBe('ses_kate_smarty');
  const box = host.querySelector('textarea');
  if (!box) throw new Error('no reply box');
  // The box shows the session's draft (the store keeps it while the page is closed).
  await act(async () => { useFeedStore.getState().setDraft('ses_kate_smarty', 'Please check my PRs'); });
  expect(box.value).toBe('Please check my PRs');
  await pressEnter(box, true); // Shift+Enter is a new line, not a send.
  expect(sent).toEqual([]);
  await pressEnter(box, false); await settle();
  expect(sent.map(({ sessionId, text }) => ({ sessionId, text }))).toEqual([{ sessionId: 'ses_kate_smarty', text: 'Please check my PRs' }]);
  expect(sent[0]?.messageID.startsWith('msg')).toBe(true);
  expect(readFeedDraft('ses_kate_smarty')).toBe('');
  expect(box.value).toBe('');
  await act(async () => root.unmount());
});
