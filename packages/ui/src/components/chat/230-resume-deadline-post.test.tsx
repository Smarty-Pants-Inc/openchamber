import { expect, test } from 'bun:test';
import { CONTINUE, deadlineChat, target } from './230-resume-deadline-chat.fixture';
import { operation } from './230-resume-deadline-http.fixture';
import { loaded, recover } from './230-resume-deadline-recovery.helper';

for (const hold of ['headers', 'body'] as const) test(`accepted POST with held ${hold} expires to read-only recovery through actual parent`, async () => {
  const f = await deadlineChat();
  try {
    await loaded(f); await f.click(CONTINUE);
    const post = await f.post.take(), requestId = f.requestId(post);
    expect(post.method).toBe('POST'); expect(post.url.searchParams.get('directory')).toBe(target.directory);
    expect(post.body).toBe(JSON.stringify({ sessionID: target.sessionID, clientRequestId: requestId }));
    const reply = Response.json({ nativeCreation: operation('ready', requestId) }, { status: 202 });
    const late = hold === 'body' ? await post.partial(reply) : () => post.reply(reply);
    expect(f.status()).toMatchObject({ status: 'starting', requestId });
    await f.waitDeadline();
    await recover(f, requestId, late);
    expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  } finally { await f.close(); }
}, 95_000);
