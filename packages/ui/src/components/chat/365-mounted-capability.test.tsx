import { expect, test } from 'bun:test';
import { act } from 'react';
import { mountedChat, ended, target } from './365-mounted-chat.fixture';
import { pageReply } from './365-mounted-http.fixture';
import { sidebarHerdrI18n } from '@/lib/i18n/messages/sidebar-herdr.i18n';

const CONTINUE = 'Continue in a new Pi';
async function loaded(options: Parameters<typeof mountedChat>[0] = {}) {
  const f = await mountedChat(options);
  await act(async () => (await f.page.take()).reply(pageReply(true)));
  await f.settle(() => f.loader.getSnapshot(target).status === 'ready');
  await f.settle(() => f.requests.filter(request => request.url.pathname.endsWith('/global/health')).every(request => request.responded));
  return f;
}

test('actual selected health without ordinaryResume retains ended text but never offers Continue or sends POST', async () => {
  const f = await loaded({ supported: false });
  try {
    expect(f.text()).toContain(sidebarHerdrI18n.en['sessions.sidebar.herdr.ended']);
    expect(f.buttons()).not.toContain(CONTINUE);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/global/health'))).toHaveLength(1);
    expect(f.requests.filter(request => request.method === 'POST' && request.url.pathname.endsWith('/resume'))).toHaveLength(0);
  } finally { await f.close(); }
});

test('confirmed ordinaryResume:1 on the selected directory offers Continue for an ended root', async () => {
  const f = await loaded();
  try {
    await f.settle(() => f.buttons().includes(CONTINUE));
    expect(f.text()).toContain(sidebarHerdrI18n.en['sessions.sidebar.herdr.ended']);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/global/health'))).toHaveLength(1);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/global/health'))
      .every(request => request.url.searchParams.get('directory') === target.directory)).toBe(true);
  } finally { await f.close(); }
});

for (const kind of ['fleet', 'code-unavailable', 'unknown'] as const) test(`no initial Continue on ${kind} read-only row, even with supported health`, async () => {
  const row: typeof ended & { herdrNoIdentity?: boolean } = { ...ended, herdrState: 'unknown', ordinaryCodeMade: kind === 'code-unavailable' };
  if (kind === 'unknown') row.herdrNoIdentity = true;
  const f = await loaded({ local: row });
  try {
    expect(f.buttons()).not.toContain(CONTINUE);
    expect(f.requests.filter(request => request.url.pathname.endsWith('/resume'))).toHaveLength(0);
    if (kind === 'code-unavailable') expect(f.banner()).toBeNull();
    else expect(f.banner()).not.toBeNull();
  } finally { await f.close(); }
});

test('a global ended row remains ended authority while the local row is unavailable', async () => {
  const f = await loaded({ local: { ...ended, herdrState: 'unknown' }, global: ended });
  try {
    await f.settle(() => f.buttons().includes(CONTINUE));
    expect(f.text()).toContain(sidebarHerdrI18n.en['sessions.sidebar.herdr.ended']);
  } finally { await f.close(); }
});
