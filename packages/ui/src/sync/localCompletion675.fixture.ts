import './native-test-network';
import { afterEach, expect } from 'bun:test';
import { createOpencodeClient, type AssistantMessage, type Event, type Message, type Session } from '@opencode-ai/sdk/v2/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { ChildStoreManager } from './child-store';
import { createEventRoutingIndex, handleEvent, resyncDirectorySessionStatuses } from './sync-context';
import { getImperativeSessionMessageLoader, SessionMessageLoader, setImperativeSessionMessageLoader } from './session-message-loader';

export const target = { directory: '/local-completion-675', sessionID: 'ses_local_completion_675' };
type Metadata = { smartyCodeUnsaved: boolean; smartyCodeRevision?: number };
export function record(unsaved: boolean, revision?: number) {
  return {
    info: { id: 'msg_completion_675', sessionID: target.sessionID, role: 'assistant', parentID: 'msg_prompt_675',
      modelID: 'model', providerID: 'provider', mode: 'build', agent: 'build', path: { cwd: target.directory, root: target.directory },
      cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 101 },
      metadata: { smartyCodeUnsaved: unsaved, smartyCodeRevision: revision } } satisfies AssistantMessage & { metadata: Metadata },
    parts: [{ id: 'prt_completion_675', messageID: 'msg_completion_675', sessionID: target.sessionID, type: 'text' as const, text: 'unfinished reply' }],
  };
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

export function fixture() {
  let next: { response: Response; dispatched: ReturnType<typeof deferred>; delivery: ReturnType<typeof deferred> } | undefined;
  const reads: Request[] = [], statusReads: Request[] = [], releases: (() => void)[] = [], pending: Promise<void>[] = [];
  const sdk = createOpencodeClient({ baseUrl: 'https://completion-675.invalid', fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'https://completion-675.invalid' || url.pathname !== `/session/${target.sessionID}/message`
      || request.method !== 'GET' || url.searchParams.get('directory') !== target.directory || !next) {
      throw new Error('Unexpected local-completion fixture request');
    }
    const read = next; next = undefined; reads.push(request); read.dispatched.resolve();
    await read.delivery.promise;
    return read.response;
  } });
  const children = new ChildStoreManager(), routing = createEventRoutingIndex();
  const loader = new SessionMessageLoader(children, { sdk, runtimeKey: getRuntimeKey() });
  const store = children.ensureChild(target.directory, { bootstrap: false });
  const session: Session = { id: target.sessionID, directory: target.directory, slug: 'completion', title: 'Completion fixture',
    projectID: 'completion', version: '1', time: { created: 1, updated: 1 } };
  store.setState({ session: [session], part: { msg_completion_675: [] } });
  const priorLoader = getImperativeSessionMessageLoader(), priorFetch = globalThis.fetch, priorResolver = getRuntimeUrlResolver();
  setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'https://completion-675.invalid' }));
  setImperativeSessionMessageLoader(loader);
  // The service's real SDK status method uses this synthetic transport. Every other product fetch is denied.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), 'https://completion-675.invalid'), init), url = new URL(request.url);
    if (!url.pathname.endsWith('/session/status') || request.method !== 'GET'
      || url.searchParams.get('directory') !== target.directory) throw new Error('Local-completion product network denied');
    statusReads.push(request);
    return Response.json({ [target.sessionID]: { type: 'idle' } });
  };
  cleanups.push(async () => {
    loader.dispose(); children.disposeAll(); releases.forEach(release => release()); await Promise.all(pending);
    setImperativeSessionMessageLoader(priorLoader); globalThis.fetch = priorFetch; setRuntimeUrlResolver(priorResolver);
  });
  const shown = () => (store.getState().message[target.sessionID] ?? []).filter(message => message.role === 'assistant');
  const event = (payload: Event) => handleEvent(target.directory, payload, children, routing, getRuntimeKey());
  const live = (info: Message) => event({ id: `evt_${info.id}`, type: 'message.updated', properties: { sessionID: target.sessionID, info } });
  const start = async (rows: ReturnType<typeof record>[], initial = false) => {
    const dispatched = deferred(), delivery = deferred();
    const prompt = { info: { id: 'msg_prompt_675', sessionID: target.sessionID, role: 'user' as const, time: { created: 100 },
      agent: 'build', model: { providerID: 'provider', modelID: 'model' } }, parts: [] };
    next = { response: Response.json([prompt, ...rows]), dispatched, delivery };
    releases.push(delivery.resolve);
    const done = initial ? loader.ensure(target) : loader.refreshTail(target, 50);
    pending.push(done); await dispatched.promise;
    return { done, release: delivery.resolve };
  };
  const load = async (rows: ReturnType<typeof record>[], initial = false) => {
    const read = await start(rows, initial); read.release(); await read.done;
    expect(loader.getSnapshot(target).status).toBe('ready');
  };
  const settle = async (caller: 'idle' | 'error' | 'snapshot') => {
    if (caller === 'snapshot') {
      event({ id: 'busy', type: 'session.status', properties: { sessionID: target.sessionID, status: { type: 'busy' } } });
      expect(await resyncDirectorySessionStatuses(target.directory, store, [target.sessionID], 'authoritative')).not.toBeNull();
    } else if (caller === 'idle') event({ id: 'idle', type: 'session.idle', properties: { sessionID: target.sessionID } });
    else event({ id: 'error', type: 'session.error', properties: { sessionID: target.sessionID, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } });
  };
  return { loader, store, shown, live, event, start, load, settle, reads, statusReads };
}
