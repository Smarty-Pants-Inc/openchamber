import './native-test-network';
import { afterEach, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createOpencodeClient, type Event, type Message, type UserMessage } from '@opencode-ai/sdk/v2/client';
import { HumanAuthor } from '@/components/auth/HumanAuthor';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from './child-store';
import { createEventRoutingIndex, handleEvent } from './sync-context';
import { SessionMessageLoader } from './session-message-loader';

export const target = { directory: '/stale-author-fixture', sessionID: 'ses_675_stale' };
const view = `ov2_${'b'.repeat(64)}`;
type Author = NonNullable<ReturnType<typeof trustedHumanAuthor>>;
export const author: Author = { version: 1, issuer: 'https://identity.example.test', subject: 'person-1', name: 'Person One' };
export const renamed: Author = { ...author, name: 'New recorded name' };
export const record = (id = 'msg_675', human?: Author, revision?: number, created = 101) => ({
  info: { id, sessionID: target.sessionID, role: 'user', time: { created }, agent: 'build',
    model: { providerID: 'test', modelID: 'test' }, metadata: { smartyCodeHuman: human, smartyCodeRevision: revision } } satisfies UserMessage & { metadata: { smartyCodeHuman?: Author; smartyCodeRevision?: number } },
  parts: [{ id: `prt_${id}`, messageID: id, sessionID: target.sessionID, type: 'text' as const, text: 'same steer' }],
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
export type Kind = 'initial' | 'tail' | 'older' | 'window' | 'reset';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

export function fixture() {
  let next: { response: Response; dispatched: ReturnType<typeof deferred>; delivery: ReturnType<typeof deferred> } | undefined;
  const reads: Request[] = [], releases: (() => void)[] = [], pending: Promise<void>[] = [];
  const sdk = createOpencodeClient({ baseUrl: 'https://stale-author.invalid', fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'https://stale-author.invalid' || url.pathname !== `/session/${target.sessionID}/message`
      || request.method !== 'GET' || url.searchParams.get('directory') !== target.directory || !next) {
      throw new Error('Unexpected stale-author fixture request');
    }
    const read = next;
    next = undefined;
    reads.push(request);
    read.dispatched.resolve();
    await read.delivery.promise;
    return read.response;
  } });
  const children = new ChildStoreManager(), routing = createEventRoutingIndex();
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: 'stale-author-fixture' });
  const store = children.ensureChild(target.directory, { bootstrap: false });
  cleanups.push(async () => { loader.dispose(); children.disposeAll(); releases.forEach(release => release()); await Promise.all(pending); });
  const shown = () => store.getState().message[target.sessionID] ?? [];
  const live = (info: Message) => handleEvent(target.directory,
    { id: `evt_${info.id}`, type: 'message.updated', properties: { sessionID: target.sessionID, info } },
    children, routing, getRuntimeKey());
  const event = (payload: Event) => handleEvent(target.directory, payload, children, routing, getRuntimeKey());
  const start = async (rows: ReturnType<typeof record>[], kind: Kind = 'tail', headers: HeadersInit = {}) => {
    const dispatched = deferred(), delivery = deferred();
    // Serialize before dispatch and hold delivery, not the page's capture, across the live mutation.
    const responseHeaders = new Headers(headers);
    responseHeaders.set('x-smarty-ordinary-view', view);
    next = { response: Response.json(rows, { headers: responseHeaders }), dispatched, delivery };
    releases.push(delivery.resolve);
    if (kind === 'reset') loader.invalidateOrdinaryView(target, true);
    const done = kind === 'initial' ? loader.ensure(target)
      : kind === 'older' ? loader.loadOlder(target) : kind === 'window' ? loader.loadAt(target, 0, 50)
        : loader.refreshTail(target, 50);
    pending.push(done);
    await dispatched.promise;
    return { done, release: delivery.resolve };
  };
  const load = async (rows: ReturnType<typeof record>[], kind: Kind = 'tail', headers: HeadersInit = {}) => {
    const read = await start(rows, kind, headers);
    read.release(); await read.done;
    expect(loader.getSnapshot(target).status).toBe('ready');
  };
  const label = (id = 'msg_675') => renderToStaticMarkup(createElement(HumanAuthor, { info: shown().find(info => info.id === id) }));
  return { loader, store, shown, live, event, start, load, label, reads };
}
