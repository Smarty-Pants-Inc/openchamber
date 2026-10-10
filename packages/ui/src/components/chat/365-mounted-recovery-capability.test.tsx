import { expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { mountedChat, ended, target } from './365-mounted-chat.fixture';
import { operation, pageReply, stateReply } from './365-mounted-http.fixture';

const CONTINUE = 'Continue in a new Pi', CHECK = 'Check again';
for (const health of ['absent', 'failed'] as const) test(`unknown Check again survives ${health} capability and clears only after writable loader recovery`, async () => {
  const f = await mountedChat();
  try {
    (await f.page.take()).reply(pageReply(true));
    await f.settle(() => f.loader.getSnapshot(target).status === 'ready' && f.buttons().includes(CONTINUE));
    await f.click(CONTINUE); (await f.post.take()).reply(stateReply('ready'));
    (await f.page.take()).reply(new Response('Fresh page failed', { status: 400 }));
    await f.settle(() => f.status()?.status === 'unknown');
    const original = f.status();
    if (original?.status !== 'unknown') throw new Error('Actual recovery identity missing');
    f.controls.health = () => health === 'absent' ? Response.json({ healthy: true, capabilities: {} })
      : new Response('Transient health failure', { status: 503 });
    await act(async () => useAuthSessionStore.getState().markAuthenticated());
    await f.rebindRuntime(); // Root auth recovery normally rebinds the real loader to the renewed SDK.
    await f.settle(() => {
      const probes = f.requests.filter(request => request.url.pathname.endsWith('/global/health'));
      return probes.length === 3 && probes.every(request => request.responded);
    });
    await act(async () => { await sleep(25); });
    expect(f.status()).toEqual(original);
    expect(f.buttons()).toContain(CHECK); expect(f.buttons()).not.toContain(CONTINUE);
    await f.click(CHECK); (await f.list.take()).reply(Response.json({ nativeCreations: [] }));
    await f.settle(() => { const value = f.status(); return value?.status === 'unknown' && value.checked === true; });
    expect(f.status()).toEqual({ ...original, checked: true });
    expect(f.buttons()).not.toContain(CONTINUE); // Even checked-unknown needs current affirmative support for a new POST.
    await f.row({ ...ended, herdrState: 'unknown' });
    expect(f.banner()).not.toBeNull(); expect(f.buttons()).toContain(CHECK);
    await f.click(CHECK); (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready')] }));
    const livePage = await f.page.take();
    expect(f.banner()).not.toBeNull();
    expect(f.loader.getSnapshot(target).readOnly).toBe(true);
    livePage.reply(pageReply()); await f.settle(() => f.status() === undefined);
    expect(f.banner()).toBeNull();
    expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
    expect(f.children.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(1);
  } finally { await f.close(); }
});
