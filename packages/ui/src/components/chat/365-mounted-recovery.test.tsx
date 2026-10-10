import { expect, test } from 'bun:test';
import { act } from 'react';
import { mountedChat, ended, target } from './365-mounted-chat.fixture';
import { operation, pageReply, stateReply } from './365-mounted-http.fixture';

const CONTINUE = 'Continue in a new Pi', CHECK = 'Check again';
const unavailable = { ...ended, herdrState: 'unknown', ordinary: null, ordinaryCodeMade: true };

test('mounted parent retains Check again after old read-only page, ready operation and failed fresh page', async () => {
  const f = await mountedChat();
  try {
    const old = await f.page.take(); // The actual ChatContainer started its real initial history load.
    await f.settle(() => f.buttons().includes(CONTINUE));
    expect(f.buttons()).toContain(CONTINUE);
    await f.click(CONTINUE);
    const post = await f.post.take(); post.reply(stateReply('ready'));
    await f.settle(() => { const value = f.status(); return value?.status === 'starting'
      && value.operationId === operation('ready').operationId; });
    await f.row(unavailable);
    expect(f.children.getChild(target.directory)?.getState().session[0]).toMatchObject(unavailable);
    expect(f.banner()).not.toBeNull(); // Recovery is reachable while the old page is still held.
    expect(f.buttons()).not.toContain(CONTINUE);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(1);
    await act(async () => old.reply(pageReply(true)));
    const fresh = await f.page.take(); fresh.reply(new Response('Fresh page failed', { status: 400 }));
    await f.settle(() => f.status()?.status === 'unknown');
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'error', resolved: true, readOnly: true });
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/message'))).toHaveLength(2);
    // RED at the actual parent: Code-made unavailable removes the banner despite retained recovery.
    expect(f.banner()).not.toBeNull();
    expect(f.buttons()).toContain(CHECK);
    expect(f.buttons()).not.toContain(CONTINUE);
    await f.click(CHECK);
    (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready')] }));
    (await f.page.take()).reply(pageReply());
    await f.settle(() => f.status() === undefined);
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
    expect(f.banner()).toBeNull();
    expect(f.dom.container.querySelector('[data-testid="fixture-composer"]')).not.toBeNull();
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { await f.close(); }
});
