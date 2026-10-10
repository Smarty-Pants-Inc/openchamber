import { expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { CHECK, CONTINUE, deadlineChat } from './230-resume-deadline-chat.fixture';
import { loaded } from './230-resume-deadline-recovery.helper';

for (const hold of ['headers', 'body'] as const) test(`pre-POST capability health with held ${hold} cannot strand starting or dispatch a late POST`, async () => {
  const f = await deadlineChat();
  try {
    await loaded(f); await f.health.take();
    f.controls.health = () => null;
    await f.click(CONTINUE); const health = await f.health.take();
    const supported = Response.json({ healthy: true, capabilities: { ordinaryResume: 1 } });
    const late = hold === 'body' ? await health.partial(supported) : () => health.reply(supported);
    await f.waitDeadline();
    expect(f.status()).toMatchObject({ status: 'unknown' });
    expect(f.buttons()).toContain(CHECK); expect(f.buttons()).not.toContain(CONTINUE);
    await act(async () => { late(); await sleep(25); });
    expect(f.status()).toMatchObject({ status: 'unknown' });
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  } finally { await f.close(); }
}, 95_000);
