import './native-test-network';
import { afterEach, expect, test } from 'bun:test';
import { createOpencodeClient, type UserMessage } from '@opencode-ai/sdk/v2/client';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { ChildStoreManager, subscribeDirectorySessionMessages } from './child-store';
import { applyDirectoryEvent } from './event-reducer';
import { SessionMessageLoader } from './session-message-loader';
import { optimisticMessageRecords } from './unsaved';
import { mergeMessages } from './optimistic';

const target = { directory: '/metadata-fixture', sessionID: 'ses_675' };
const view = `ov2_${'a'.repeat(64)}`;
type Author = NonNullable<ReturnType<typeof trustedHumanAuthor>>;
const author: Author = { version: 1, issuer: 'https://identity.example.test', subject: 'person-1', name: 'Person One' };
const renamed: Author = { ...author, name: 'Recorded new name' };
type Metadata = { smartyCodeRevision?: number; smartyCodeHuman?: Author; smartyCodeUnsaved?: boolean };
const record = (id = 'msg_675', metadata?: Metadata, created = 101) => ({
  info: { id, sessionID: target.sessionID, role: 'user', time: { created }, agent: 'build',
    model: { providerID: 'test', modelID: 'test' }, metadata } satisfies UserMessage & { metadata?: Metadata },
  parts: [{ id: `prt_${id}`, messageID: id, sessionID: target.sessionID, type: 'text' as const, text: 'same steer' }],
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  let page: ReturnType<typeof record>[] = [];
  const reads: Request[] = [];
  const sdk = createOpencodeClient({ baseUrl: 'https://metadata.invalid', fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'https://metadata.invalid' || url.pathname !== `/session/${target.sessionID}/message`
      || request.method !== 'GET' || url.searchParams.get('directory') !== target.directory) {
      throw new Error('Unexpected metadata fixture request');
    }
    reads.push(request);
    return Response.json(page, { headers: { 'x-smarty-ordinary-view': view } });
  } });
  const children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: 'metadata-fixture' });
  const store = children.ensureChild(target.directory, { bootstrap: false });
  cleanups.push(() => { loader.dispose(); children.disposeAll(); });
  const shown = () => store.getState().message[target.sessionID] ?? [];
  const live = (row: ReturnType<typeof record>) => {
    const state = store.getState(), draft = { ...state, message: { ...state.message } };
    applyDirectoryEvent(draft, { id: `evt_${row.info.id}`, type: 'message.updated', properties: { sessionID: target.sessionID, info: row.info } });
    store.setState({ message: draft.message });
  };
  const optimistic = (id = 'msg_675') => {
    const row = record(id, undefined, 100);
    loader.optimisticAdd({ ...target, message: row.info, parts: row.parts });
    return row;
  };
  const load = async (...rows: ReturnType<typeof record>[]) => {
    page = rows;
    await loader.refreshTail(target, 50);
    expect(loader.getSnapshot(target).status).toBe('ready');
    expect(loader.getAcceptedOrdinaryView(target, 'metadata-fixture')).toBe(view);
  };
  return { loader, store, shown, live, optimistic, load, reads };
}

// The same ID is echoed by the server in this fixture. No client/native ID mapping or text matching is assumed.
for (const revision of [undefined, 7]) {
  for (const prior of [undefined, author]) {
    test(`history ${prior ? 'changes' : 'adds'} author after live promotion, revision ${revision ?? 'absent'}`, async () => {
      const f = fixture(), shadow = f.optimistic();
      f.live(record('msg_675', { smartyCodeRevision: revision, smartyCodeHuman: prior }));
      const live = f.shown()[0];
      expect(live).not.toBe(shadow.info);
      expect(optimisticMessageRecords.has(live)).toBe(false);
      expect(trustedHumanAuthor(live)).toEqual(prior);
      const parts = f.store.getState().part;
      const incoming = record('msg_675', { smartyCodeRevision: revision, smartyCodeHuman: renamed });
      incoming.info.agent = 'page-agent';
      await f.load(incoming);
      expect(f.shown()).toHaveLength(1);
      expect(trustedHumanAuthor(f.shown()[0])).toEqual(renamed);
      expect(f.shown()[0]).toMatchObject({ agent: 'build', time: live.time });
      expect(f.store.getState().part).toBe(parts);
      expect(f.reads).toHaveLength(1);
    });
  }
}

test('identical authoritative replacements preserve row, bucket, parts and subscriber references', async () => {
  const f = fixture();
  f.live(record('msg_675', { smartyCodeRevision: 7, smartyCodeHuman: author }));
  await f.load(record('msg_675', { smartyCodeRevision: 7, smartyCodeHuman: author }));
  const before = f.store.getState(), row = f.shown()[0], bucket = f.shown();
  let notifications = 0;
  const unsubscribe = subscribeDirectorySessionMessages(f.store, target.sessionID, () => { notifications++; });
  try {
    // A decoded replacement, including reordered author keys, is the same rendered snapshot.
    const equivalent: Author = { name: author.name, subject: author.subject, issuer: author.issuer, version: author.version };
    for (let i = 0; i < 20; i++) await f.load(record('msg_675', { smartyCodeHuman: equivalent, smartyCodeRevision: 7 }));
    expect(f.shown()[0]).toBe(row);
    expect(f.shown()).toBe(bucket);
    expect(f.store.getState().message).toBe(before.message);
    expect(f.store.getState().part).toBe(before.part);
    expect(notifications).toBe(0);
    expect(f.reads).toHaveLength(21);
  } finally { unsubscribe(); }
});

for (const olderAuthor of [undefined, renamed]) {
  test(`older revision cannot ${olderAuthor ? 'change' : 'erase'} server author`, async () => {
    const f = fixture();
    f.optimistic();
    f.live(record('msg_675', { smartyCodeRevision: 9, smartyCodeHuman: author }));
    const row = f.shown()[0];
    await f.load(record('msg_675', { smartyCodeRevision: 8, smartyCodeHuman: olderAuthor }));
    expect(f.shown()[0]).toBe(row);
    expect(trustedHumanAuthor(f.shown()[0])).toEqual(author);
    // The event path has the same freshness guard as the page path.
    f.live(record('msg_675', { smartyCodeRevision: 8, smartyCodeHuman: olderAuthor }));
    expect(f.shown()[0]).toBe(row);
  });
}

test('a page retaining the optimistic shadow cannot overwrite an already promoted server author', async () => {
  const f = fixture(), shadow = f.optimistic();
  shadow.info.metadata = { smartyCodeRevision: 99, smartyCodeHuman: renamed };
  f.live(record('msg_675', { smartyCodeRevision: 9, smartyCodeHuman: author }));
  const row = f.shown()[0];
  // The tail does not yet contain this ID; mergeOptimisticPage appends its tracked shadow.
  await f.load(record('msg_other', undefined, 102));
  expect(f.shown().find(info => info.id === shadow.info.id)).toBe(row);
  expect(trustedHumanAuthor(row)).toEqual(author);
  expect(optimisticMessageRecords.has(shadow.info)).toBe(true);
  const bucket = f.shown();
  expect(mergeMessages(bucket, [shadow.info])).toBe(bucket);
});

test('same-text messages with distinct authoritative IDs stay distinct across live and history reconciliation', async () => {
  const f = fixture();
  f.optimistic('msg_first'); f.optimistic('msg_second');
  const second: Author = { ...author, subject: 'person-2', name: 'Person Two' };
  f.live(record('msg_first', {}, 101));
  f.live(record('msg_second', {}, 102));
  expect(f.shown().every(info => !optimisticMessageRecords.has(info))).toBe(true);
  const firstPage = record('msg_first', { smartyCodeHuman: author }, 101);
  const secondPage = record('msg_second', { smartyCodeHuman: second }, 102);
  expect(firstPage.parts[0].text).toBe(secondPage.parts[0].text);
  await f.load(secondPage, firstPage);
  expect(f.shown().map(info => info.id)).toEqual(['msg_first', 'msg_second']);
  expect(f.shown().map(trustedHumanAuthor)).toEqual([author, second]);
  await f.load(firstPage, secondPage);
  expect(f.shown()).toHaveLength(2);
});
