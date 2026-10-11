import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { toast } from 'sonner';
import { mountedChat, target } from './365-mounted-chat.fixture';
import { pageReply } from './365-mounted-http.fixture';

// Issue #1176 counterexample: a Beginning read held over runtime A answers its floor 413 after the reader switched to
// runtime B with the same selected session id and directory. The retired answer must report nothing and move nothing.
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

const positioned = async () => {
  const page = pageReply();
  const headers = new Headers(page.headers);
  headers.set('x-smarty-at', '999'); headers.set('x-smarty-total', '1000'); headers.set('x-smarty-index-epoch', 'e1');
  return new Response(await page.text(), { status: 200, headers });
};
const tooLarge = () => Response.json({ message: 'window too large' }, { status: 413 });
const at = (url: URL) => Number(url.searchParams.get('at'));

test('a floor 413 from a Beginning read retired by a same-session runtime switch shows no toast and starts no read-ahead', async () => {
  const shown: string[] = [];
  spies.push(spyOn(toast, 'error').mockImplementation(message => { shown.push(String(message)); return 'toast'; }));
  const f = await mountedChat();
  const latestMessageRead = () => {
    const read = f.requests.filter(request => request.url.pathname.endsWith('/message')).at(-1);
    if (!read) throw new Error('History HTTP receipt missing');
    return read;
  };
  try {
    // The actual ChatContainer loads the newest page over runtime A; positions make Beginning available.
    await f.page.take();
    const initial = latestMessageRead();
    expect(at(initial.url)).toBeLessThan(0);
    initial.reply(await positioned());
    await f.settle(() => f.loader.getSnapshot(target).positions?.total === 1000
      && f.dom.container.querySelector('[data-scroll-to-start]') !== null);

    await act(async () => {
      f.dom.container.querySelector<HTMLButtonElement>('[data-scroll-to-start]')?.click(); await sleep(0);
    });
    // Runtime A halves the too-large Beginning window down to the floor; the floor read is still pending.
    for (const size of [500, 250, 125, 62, 31]) {
      await f.page.take();
      const read = latestMessageRead();
      expect({ at: at(read.url), limit: Number(read.url.searchParams.get('limit')) }).toEqual({ at: 0, limit: size });
      read.reply(tooLarge());
    }
    await f.page.take();
    const floor = latestMessageRead();
    expect({ at: at(floor.url), limit: Number(floor.url.searchParams.get('limit')) }).toEqual({ at: 0, limit: 25 });
    expect(floor.url.pathname.startsWith('/b/')).toBe(false);

    // Runtime B: a different endpoint, the same selected session id and directory.
    await f.switchEndpoint('/b');
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    expect(useSessionUIStore.getState()).toMatchObject({ currentSessionId: target.sessionID, currentSessionDirectory: target.directory });
    const before = f.requests.length;

    await act(async () => { floor.reply(tooLarge()); await sleep(25); });
    await act(async () => { await sleep(50); }); // Any stale animation frame and read-ahead would run here.

    expect(floor.responded).toBe(true);
    expect(shown).toEqual([]);
    // No stale read-ahead: nothing after the retired answer reads a window at a non-negative position.
    const after = f.requests.slice(before).filter(request => request.url.pathname.endsWith('/message'));
    expect(after.filter(request => at(request.url) >= 0)).toEqual([]);
    expect(f.loader.getSnapshot(target).status).not.toBe('error');
  } finally { await f.close(); }
});
