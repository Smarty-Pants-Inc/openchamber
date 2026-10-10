import './native-test-network';
import { afterEach, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createOpencodeClient, type Message, type Part } from '@opencode-ai/sdk/v2/client';
import { HumanAuthor } from '@/components/auth/HumanAuthor';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import { useConfigStore } from '@/stores/useConfigStore';
import { ChildStoreManager } from './child-store';
import { createEventRoutingIndex, handleEvent } from './sync-context';
import { SessionMessageLoader } from './session-message-loader';
import { optimisticSend, setActionRefs, setOptimisticRefs } from './session-actions';
import { target } from './675-stale-read.fixture';

export { author, renamed, record, target } from './675-stale-read.fixture';
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

export function confirmationFixture() {
  const queue: { response: Response; dispatched: ReturnType<typeof deferred>; delivery: ReturnType<typeof deferred> }[] = [];
  const reads: Request[] = [], posts: Request[] = [], releases: (() => void)[] = [], pending: Promise<void>[] = [];
  const postDispatched = deferred(), postDelivery = deferred();
  const counts = { sends: 0, confirms: 0, removes: 0 };
  let unexpectedRequests = 0;
  const rejectRequest = (): never => { unexpectedRequests++; throw new Error('Unexpected confirmation675 request'); };
  const sdk = createOpencodeClient({ baseUrl: 'https://confirmation675.invalid', fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'https://confirmation675.invalid' || url.searchParams.get('directory') !== target.directory) {
      return rejectRequest();
    }
    if (request.method === 'POST' && url.pathname === `/session/${target.sessionID}/prompt_async`) {
      if (posts.length !== 0) return rejectRequest();
      posts.push(request); postDispatched.resolve(); await postDelivery.promise;
      throw markAmbiguousTransportFailure(new Error('Synthetic dispatched send lost its receipt'));
    }
    const read = queue.shift();
    if (request.method !== 'GET' || url.pathname !== `/session/${target.sessionID}/message` || !read) {
      return rejectRequest();
    }
    reads.push(request); read.dispatched.resolve(); await read.delivery.promise;
    return read.response;
  } });
  const children = new ChildStoreManager(), routing = createEventRoutingIndex();
  const store = children.ensureChild(target.directory, { bootstrap: false });
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: getRuntimeKey() });
  setActionRefs(sdk, children, () => target.directory);
  setOptimisticRefs(
    input => loader.optimisticAdd({ ...input, directory: target.directory }),
    input => { counts.removes++; loader.optimisticRemove({ ...input, directory: target.directory }); },
    input => { counts.confirms++; loader.optimisticConfirm({ ...input, directory: target.directory }); },
  );
  const previousConnected = useConfigStore.getState().isConnected;
  useConfigStore.setState({ isConnected: true });
  cleanups.push(async () => {
    loader.dispose(); children.disposeAll(); postDelivery.resolve(); releases.forEach(release => release());
    await Promise.all(pending); useConfigStore.setState({ isConnected: previousConnected });
    expect(unexpectedRequests).toBe(0);
  });
  const shown = () => store.getState().message[target.sessionID] ?? [];
  const live = (info: Message) => handleEvent(target.directory,
    { id: `evt_${info.id}`, type: 'message.updated', properties: { sessionID: target.sessionID, info } },
    children, routing, getRuntimeKey());
  const enqueue = (rows: Array<{ info: Message; parts: Part[] }>, status = 200) => {
    const dispatched = deferred(), delivery = deferred();
    queue.push({ response: Response.json(rows, { status }), dispatched, delivery });
    releases.push(delivery.resolve);
    return { dispatched: dispatched.promise, release: delivery.resolve };
  };
  const start = async () => {
    const done = optimisticSend({ sessionId: target.sessionID, directory: target.directory, messageID: 'msg_675',
      content: 'same steer', providerID: 'test', modelID: 'test', send: async messageID => {
        counts.sends++;
        await sdk.session.promptAsync({ ...target, messageID, parts: [{ type: 'text', text: 'same steer' }] }, { throwOnError: true });
      },
    }).then(() => undefined, error => error instanceof Error ? error : new Error('Unexpected non-Error send failure'));
    pending.push(done.then(() => {}));
    await postDispatched.promise;
    expect(shown()).toHaveLength(1);
    return { done, failReceipt: postDelivery.resolve };
  };
  const label = () => renderToStaticMarkup(createElement(HumanAuthor, { info: shown().find(info => info.id === 'msg_675') }));
  return { sdk, children, store, loader, shown, live, enqueue, start, label, reads, posts, counts };
}
