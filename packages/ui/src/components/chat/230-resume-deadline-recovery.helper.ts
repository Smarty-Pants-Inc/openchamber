import { expect } from 'bun:test';
import { act } from 'react';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { CHECK, CONTINUE, target, type deadlineChat } from './230-resume-deadline-chat.fixture';
import { operation, pageReply } from './230-resume-deadline-http.fixture';
type Fixture = Awaited<ReturnType<typeof deadlineChat>>;
export async function loaded(f: Fixture) {
  (await f.page.take()).reply(pageReply(true));
  await f.settle(() => f.loader.getSnapshot(target).status === 'ready' && f.buttons().includes(CONTINUE));
}
export async function recover(f: Fixture, requestId: string, late: () => void = () => {}) {
  expect(f.status()).toMatchObject({ status: 'unknown', requestId });
  expect(f.buttons()).toContain(CHECK); expect(f.buttons()).not.toContain(CONTINUE);
  await f.remount();
  expect(f.buttons()).toContain(CHECK);
  await f.click(CHECK);
  (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready', requestId)] }));
  await f.rowUnavailable();
  const fresh = await f.page.take();
  await act(async () => late());
  expect(f.banner()).not.toBeNull(); expect(f.composer()).toBeNull();
  fresh.reply(pageReply(true));
  await f.settle(() => f.status()?.status === 'unknown');
  expect(f.buttons()).toContain(CHECK);
  await f.click(CHECK);
  (await f.list.take()).reply(Response.json({ nativeCreations: [operation('ready', requestId)] }));
  (await f.page.take()).reply(pageReply());
  await f.settle(() => f.status() === undefined);
  expect(f.loader.getSnapshot(target)).toMatchObject({ status: 'ready', resolved: true, readOnly: false });
  expect(f.loader.getAcceptedOrdinaryView(target, getRuntimeKey())).toBe(`ov2_${'a'.repeat(64)}`);
  expect(f.children.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(1);
  expect(f.banner()).toBeNull(); expect(f.composer()).not.toBeNull();
  expect(f.requests.filter(request => request.method === 'POST' && request.url.pathname.endsWith('/resume'))).toHaveLength(1);
}
