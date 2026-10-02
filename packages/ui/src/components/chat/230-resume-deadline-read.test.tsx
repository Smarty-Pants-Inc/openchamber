import { expect, test } from 'bun:test';
import { CONTINUE, deadlineChat } from './230-resume-deadline-chat.fixture';
import { operation } from './230-resume-deadline-http.fixture';
import { loaded, recover } from './230-resume-deadline-recovery.helper';

for (const hold of ['headers', 'body'] as const) test(`starting POST then operation GET with held ${hold} expires with its actual operation identity`, async () => {
  const f = await deadlineChat();
  try {
    await loaded(f); await f.click(CONTINUE);
    const post = await f.post.take(), requestId = f.requestId(post);
    post.reply(Response.json({ nativeCreation: operation('starting', requestId) }, { status: 202 }));
    const read = await f.read.take(); expect(read.method).toBe('GET');
    const reply = Response.json({ nativeCreation: operation('ready', requestId) });
    const late = hold === 'body' ? await read.partial(reply) : () => read.reply(reply);
    await f.waitDeadline();
    expect(f.status()).toMatchObject({ status: 'unknown', requestId, operationId: operation('ready').operationId });
    await recover(f, requestId, late);
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  } finally { await f.close(); }
}, 95_000);
