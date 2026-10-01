import { expect, test } from 'bun:test';
import { act } from 'react';
import { CONTINUE, deadlineChat, resume, target } from './230-resume-deadline-chat.fixture';
import { loaded, recover } from './230-resume-deadline-recovery.helper';

for (const hold of ['headers', 'body'] as const) test(`Check list with held ${hold} remains unknown, never checked-empty, and a newer check owns recovery`, async () => {
  const f = await deadlineChat();
  try {
    await loaded(f); await f.click(CONTINUE);
    const post = await f.post.take(), requestId = f.requestId(post); post.lose();
    await f.settle(() => f.status()?.status === 'unknown');
    let settled = false;
    act(() => { void resume.checkContinue(target.directory, target.sessionID).then(() => { settled = true; }); });
    const list = await f.list.take();
    const reply = Response.json({ nativeCreations: [] });
    const late = hold === 'body' ? await list.partial(reply) : () => list.reply(reply);
    await f.waitDeadline();
    expect(settled).toBe(true);
    const value = f.status();
    expect(value).toMatchObject({ status: 'unknown', requestId });
    expect(value?.status === 'unknown' ? value.checked : undefined).toBeUndefined();
    // The old list settles only after a newer ready check has claimed this tuple.
    await recover(f, requestId, late);
  } finally { await f.close(); }
}, 95_000);
