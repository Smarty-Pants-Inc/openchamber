import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRoot } from 'react-dom/client';
import { nativeComposerDom } from '@/components/chat/composer/submit/__tests__/nativeComposer-dom';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { ChildStoreManager } from './child-store';
import { SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';
import * as resume from './native-session-resume';
import { recoveryHttp, target, type Receipt } from './365-recovery-http.fixture';

export { resume, target };
/** Actual status hook plus actual loader, SDK, runtimeFetch and private HTTP transport. No mounted chat claim. */
export async function recoveryFixture() {
  const http = await recoveryHttp(), dom = nativeComposerDom(), resolver = getRuntimeUrlResolver();
  Object.defineProperty(dom.window, '__OPENCHAMBER_API_BASE_URL__', { value: http.base, configurable: true });
  configureRuntimeUrlResolver({ apiBaseUrl: http.base });
  const children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk: opencodeClient.getSdkClient(), runtimeKey: getRuntimeKey() });
  setImperativeSessionMessageLoader(loader); resume.resetContinueForPage();
  const root = createRoot(dom.container);
  let status: resume.ContinueStatus | undefined;
  function Status() {
    status = resume.useContinueStatus(target.sessionID, target.directory);
    return React.createElement('span', null, JSON.stringify(status) ?? 'clear');
  }
  await act(async () => root.render(React.createElement(Status)));
  const poll = resume.resumeTiming.poll;
  const observed = (queue: { take: () => Promise<Receipt> }) => ({ take: async () => {
    let receipt: Receipt | undefined;
    await act(async () => { receipt = await queue.take(); });
    if (!receipt) throw new Error('HTTP receipt missing');
    return receipt;
  } });
  return { ...http, raw: http, page: observed(http.page), post: observed(http.post), list: observed(http.list), read: observed(http.read),
    loader, children, dom, status: () => status,
    render: async () => { await act(async () => root.render(React.createElement(Status))); },
    start: (work: () => Promise<void>) => { let pending = Promise.resolve(); act(() => { pending = work(); }); return pending; },
    settle: async (promise: Promise<void>) => { await act(async () => { await promise; }); },
    waitForStatus: async (matches: (value: resume.ContinueStatus | undefined) => boolean) => {
      for (let turn = 0; turn < 100 && !matches(status); turn++) await act(async () => { await sleep(1); });
      if (!matches(status)) throw new Error('Expected current Continue status was not observed');
    },
    close: async () => {
      await act(async () => { root.unmount(); await http.close(); });
      setImperativeSessionMessageLoader(null); loader.dispose(); children.disposeAll();
      resume.resetContinueForPage(); resume.resumeTiming.poll = poll; setRuntimeUrlResolver(resolver);
      await dom.restore();
    } };
}
