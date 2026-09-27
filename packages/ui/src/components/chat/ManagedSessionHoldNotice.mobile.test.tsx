import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// smarty-code#608 (pre-check): the mobile shell keeps its sessions sheet in local state; "Show projects" must reach it
// through the opener that shell registers, not only the desktop sidebar.
const browser = new Window({ url: 'http://runtime.test/' });
const install = <T,>(name: string, value: T) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
install('window', browser);
install('document', browser.document);
install('navigator', browser.navigator);
install('localStorage', browser.localStorage);
install('sessionStorage', browser.sessionStorage);
install('CustomEvent', browser.CustomEvent);
install('HTMLElement', browser.HTMLElement);
install('Element', browser.Element);
install('Node', browser.Node);
install('IS_REACT_ACT_ENVIRONMENT', true);
const { openRegisteredSessions, useDeepLinkHandlers } = await import('@/apps/deepLinkNavigation');
afterAll(async () => { await browser.happyDOM.abort(); });

test('Show projects opens the sessions list the mobile shell registered; without one it reports none', async () => {
  expect(openRegisteredSessions()).toBe(false); // The desktop: no registered opener (it uses the sidebar).
  let opened = 0;
  const handlers = { openSessions: () => { opened += 1; } };
  const Shell = () => { useDeepLinkHandlers(handlers); return null; };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Shell />); });
  expect(openRegisteredSessions()).toBe(true);
  expect(opened).toBe(1);
  await act(async () => { root.unmount(); });
  expect(openRegisteredSessions()).toBe(false);
});
