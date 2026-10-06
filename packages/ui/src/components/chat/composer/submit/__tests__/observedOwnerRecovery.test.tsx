import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { deferred, directory as A, session } from '@/sync/native-draft-fixture';
import { checkSelectedSessionOwner } from '@/sync/selected-session-owner';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { createChatDraftIdentity, readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';

const B = '/native-project-b';
const ordinary = { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' };
const row = (directory: string, ended = false) => ({ ...session, directory, ordinary, nativeRuntime: 'ordinary',
  herdrState: ended ? 'ended' : 'idle', herdrPaneLive: !ended });
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
let restoreDetail = () => {};
const originalDelay = sendUnconfirmed.ms;
afterEach(async () => {
  restoreDetail(); restoreDetail = () => {}; sendUnconfirmed.ms = originalDelay;
  await mounted?.dispose(); mounted = undefined;
});
const settle = () => act(async () => { await sleep(20); });

async function mount(persist = false) {
  const c = mounted = await mountedNativeComposer(persist, undefined, undefined, undefined, f => {
    useProjectsStore.setState({ managedCatalogAdmitted: true, managedCatalogStatus: 'ready',
      managedRows: [{ id: 'a', worktree: A }, { id: 'b', worktree: B }],
      managedProjects: [{ id: 'a', path: A, addedAt: 0, lastOpenedAt: 0 }, { id: 'b', path: B, addedAt: 0, lastOpenedAt: 0 }] });
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row(A, true)] });
    useGlobalSessionsStore.getState().applySnapshot([], []);
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A,
      selectedManagedOwner: null, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname === 'synthetic.invalid' && request.method === 'GET' && url.pathname.endsWith(`/session/${session.id}`)) {
      c.requests.push(request); return Response.json(row(B));
    }
    return previous(input, init);
  };
  restoreDetail = () => { globalThis.fetch = previous; };
  const identity = (directory: string) => createChatDraftIdentity(c.runtimeA, directory, session.id)!;
  await c.replace('Unsent investigation'); await c.mention('confirmed.md'); await c.mention('NOTES');
  return { ...c, identity };
}

async function conflict() {
  const c = await mount(), text = c.text(), editor = c.editor();
  let writes = 0, bytes: string | null = null;
  const stop = c.children.ensureChild(B, { bootstrap: false }).subscribe(state => {
    if (!writes && state.session.some(row => row.id === session.id)) {
      writes++; writeChatDraft(c.identity(B), 'Concurrent destination @destination.md', ['destination.md']);
      bytes = getSafeStorage().getItem('openchamber.chatDrafts.v2');
    }
  });
  try { await act(async () => { await checkSelectedSessionOwner(session.id, A); }); } finally { stop(); }
  expect(writes).toBe(1); expect(c.editor()).toBe(editor); expect(c.text()).toBe(text);
  expect(useSessionUIStore.getState().selectedManagedOwner?.status).toBe('live');
  await act(async () => useUIStore.setState({ persistChatDraft: true }));
  await c.replace(`${text} edited`);
  await act(async () => { await sleep(550); window.dispatchEvent(new Event('pagehide')); });
  expect(readChatDraft(c.identity(A)).text).toBe('');
  expect(getSafeStorage().getItem('openchamber.chatDrafts.v2')).toBe(bytes);
  highlighted(c);
  return { ...c, retainedText: `${text} edited`, bytes };
}

function highlighted(c: Awaited<ReturnType<typeof mount>>) {
  expect([...c.editor().dom.querySelectorAll('span')].some(node => node.textContent === '@NOTES'
    && node.className.includes('--status-info'))).toBe(true);
}

for (const exit of ['shown', 'offscreen', 'remount'] as const) test(`protected destination survives failed send recovery ${exit}`, async () => {
  const c = await conflict(), response = deferred<Response>();
  c.handlers.prompt = async () => response.promise;
  await c.submit(); expect(c.prompts()).toHaveLength(1); expect(c.text()).toBe('');
  if (exit === 'offscreen') await act(async () => useSessionUIStore.setState({ currentSessionId: 'unrelated', currentSessionDirectory: B }));
  if (exit === 'remount') await act(async () => c.remount());
  await act(async () => { response.resolve(new Response(null, { status: 409 })); await sleep(20); });
  if (exit === 'shown') {
    expect(c.text()).toBe(c.retainedText); highlighted(c);
    expect(c.dom.container.querySelector('[role="alert"]')?.textContent).toContain('Copy');
  } else if (exit === 'offscreen') {
    expect(c.text()).toBe('');
    await act(async () => useSessionUIStore.setState({ currentSessionId: session.id, currentSessionDirectory: B }));
    await settle(); expect(c.text()).toContain(c.retainedText); highlighted(c);
  } else expect(c.text()).toBe('Concurrent destination @destination.md');
  // A remount now edits B itself: disabling its persistence would intentionally delete B, not test A's recovery.
  if (exit !== 'remount') {
    await act(async () => { await sleep(550); window.dispatchEvent(new Event('pagehide')); document.dispatchEvent(new Event('freeze')); });
    await act(async () => useUIStore.setState({ persistChatDraft: false }));
    await act(async () => useUIStore.setState({ persistChatDraft: true }));
  }
  expect(readChatDraft(c.identity(A)).text).toBe('');
  expect(readChatDraft(c.identity(B))).toEqual({ text: 'Concurrent destination @destination.md', confirmedMentions: new Set(['destination.md']) });
  expect(getSafeStorage().getItem('openchamber.chatDrafts.v2')).toBe(c.bytes);
  expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(1);
});

for (const persist of [false, true]) test(`ordinary nonconflict failed send restores captured text and mentions, persistence ${persist}`, async () => {
  const c = await mount(persist), text = c.text();
  await act(async () => { await checkSelectedSessionOwner(session.id, A); });
  c.handlers.prompt = async () => new Response(null, { status: 409 });
  await c.submit(); await settle();
  expect(c.text()).toBe(text); highlighted(c);
  expect(readChatDraft(c.identity(B))).toEqual({ text, confirmedMentions: new Set(['confirmed.md', 'NOTES']) });
  expect(c.prompts()).toHaveLength(1); expect(c.creates()).toHaveLength(0);
});

for (const persist of [false, true]) test(`ordinary offscreen failed send restores only captured A, persistence ${persist}`, async () => {
  const c = await mount(persist), text = c.text(), response = deferred<Response>();
  // This control keeps A selected and live; no verified move or destination protection.
  await act(async () => c.children.getChild(A)!.setState({ session: [row(A)] }));
  c.handlers.prompt = async () => response.promise;
  await c.submit(); expect(c.prompts()).toHaveLength(1);
  await act(async () => useSessionUIStore.setState({ currentSessionId: 'unrelated', currentSessionDirectory: B }));
  await c.replace('Other visible input');
  await act(async () => { response.resolve(new Response(null, { status: 409 })); await sleep(20); });
  expect(c.text()).toBe('Other visible input');
  expect(readChatDraft(c.identity(A))).toEqual({ text, confirmedMentions: new Set(['confirmed.md', 'NOTES']) });
  expect(readChatDraft(c.identity(B)).text).toBe(''); expect(c.prompts()).toHaveLength(1);
});

for (const persist of [false, true]) for (const timing of ['before', 'after'] as const) {
  test(`pending Send follows verified move ${timing} watchdog, drafts ${persist}`, async () => {
    const c = await mount(persist), text = c.text(), first = deferred<Response>();
    await act(async () => c.children.getChild(A)!.setState({ session: [row(A)] }));
    sendUnconfirmed.ms = 250;
    c.handlers.prompt = async () => first.promise;
    await act(async () => useInputStore.setState({
      attachedFiles: [{ id: 'pending-file', filename: 'context.md', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,bm90ZXM=',
        source: 'local', file: new File(['notes'], 'context.md', { type: 'text/plain' }), size: 5 }],
      pendingSyntheticParts: [{ text: 'Pending move context', synthetic: true }],
    }));
    await c.submit(); expect(c.prompts()).toHaveLength(1); expect(c.text()).toBe('');
    if (timing === 'after') { await act(async () => { await sleep(300); }); expect(c.text()).toBe(text); }
    await act(async () => { await checkSelectedSessionOwner(session.id, A); });
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(B);
    await act(async () => { await sleep(300); });
    expect(c.text()).toBe(text); highlighted(c);
    expect(useInputStore.getState().attachedFiles.map(file => file.id)).toEqual(['pending-file']);
    expect(useInputStore.getState().pendingSyntheticParts?.map(part => part.text)).toEqual(['Pending move context']);
    expect(c.prompts()).toHaveLength(1); // Adoption and the watchdog never replay POST.
    c.handlers.prompt = async () => new Response(JSON.stringify({ message: 'client message id already exists or a submission is pending' }), { status: 409 });
    await c.submit(); await settle(); expect(c.prompts()).toHaveLength(2);
    const sent = await Promise.all(c.prompts().map(request => request.clone().json()));
    expect(sent[1].messageID).toBe(sent[0].messageID);
    expect(new URL(c.prompts()[0].url).searchParams.get('directory')).toBe(A);
    expect(new URL(c.prompts()[1].url).searchParams.get('directory')).toBe(B);
    await act(async () => { await sleep(300); }); expect(c.text()).toBe(text);
    await act(async () => { first.resolve(new Response(null, { status: 204 })); await sleep(20); });
    expect(c.text()).toBe(''); expect(readChatDraft(c.identity(B)).text).toBe('');
    expect(useInputStore.getState().attachedFiles).toHaveLength(0);
    expect(useInputStore.getState().pendingSyntheticParts).toHaveLength(0);
    expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(2);
  });
}

for (const persist of [false, true]) for (const timing of ['before', 'after'] as const) {
  for (const newer of ['untouched', 'next-input', 'edited-copy', 'retyped-copy'] as const) {
    test(`moved pending Send late acceptance keeps ${newer}, ${timing} watchdog, drafts ${persist}`, async () => {
      const c = await mount(persist), text = c.text(), first = deferred<Response>();
      await act(async () => c.children.getChild(A)!.setState({ session: [row(A)] }));
      sendUnconfirmed.ms = 250; c.handlers.prompt = async () => first.promise;
      await c.submit(); expect(c.prompts()).toHaveLength(1);
      if (timing === 'after') { await act(async () => { await sleep(300); }); expect(c.text()).toBe(text); }
      await act(async () => { await checkSelectedSessionOwner(session.id, A); });
      expect(useSessionUIStore.getState().currentSessionDirectory).toBe(B);
      const next = 'Newer request';
      if (newer === 'next-input') await c.replace(timing === 'before' ? next : `${next}\n\n${text}`);
      await act(async () => { await sleep(300); });
      expect(c.text()).toContain(text); highlighted(c);
      const edited = text.replace('investigation', 'edited investigation');
      if (newer === 'edited-copy') await c.replace(edited);
      if (newer === 'retyped-copy') { await c.replace('Replacement input'); await c.replace(text); }
      expect(c.prompts()).toHaveLength(1);
      await act(async () => { first.resolve(new Response(null, { status: 204 })); await sleep(20); });
      expect(c.text()).toBe(newer === 'next-input' ? `${next}\n\n` : newer === 'edited-copy' ? edited : newer === 'retyped-copy' ? text : '');
      await act(async () => { window.dispatchEvent(new Event('pagehide')); });
      expect(readChatDraft(c.identity(A)).text).toBe('');
      if (persist || newer === 'untouched') expect(readChatDraft(c.identity(B)).text).toBe(c.text());
      expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(1);
    });
  }
}

for (const persist of [false, true]) test(`moved pending Send late acceptance is scoped offscreen, drafts ${persist}`, async () => {
  const c = await mount(persist), text = c.text(), first = deferred<Response>();
  await act(async () => c.children.getChild(A)!.setState({ session: [row(A)] }));
  sendUnconfirmed.ms = 250; c.handlers.prompt = async () => first.promise;
  await c.submit(); await act(async () => { await checkSelectedSessionOwner(session.id, A); });
  await act(async () => { await sleep(300); }); expect(c.text()).toBe(text);
  await act(async () => useSessionUIStore.setState({ currentSessionId: 'unrelated', currentSessionDirectory: B }));
  await c.replace('Other visible input');
  await act(async () => { first.resolve(new Response(null, { status: 204 })); await sleep(20); });
  expect(c.text()).toBe('Other visible input');
  expect(readChatDraft(c.identity(A)).text).toBe(''); expect(readChatDraft(c.identity(B)).text).toBe('');
  expect(c.prompts()).toHaveLength(1); expect(c.creates()).toHaveLength(0);
});

for (const persist of [false, true]) for (const timing of ['before', 'after'] as const) {
  test(`pending move protects concurrent destination draft ${timing} watchdog, drafts ${persist}`, async () => {
    const c = await mount(persist), text = c.text(), first = deferred<Response>();
    await act(async () => c.children.getChild(A)!.setState({ session: [row(A)] }));
    sendUnconfirmed.ms = 250; c.handlers.prompt = async () => first.promise;
    await c.submit(); expect(c.prompts()).toHaveLength(1);
    if (timing === 'after') await act(async () => { await sleep(300); });
    const destination = 'Concurrent destination @destination.md';
    let wrote = false;
    const stop = c.children.ensureChild(B, { bootstrap: false }).subscribe(state => {
      if (wrote || !state.session.some(row => row.id === session.id)) return;
      wrote = true; writeChatDraft(c.identity(B), destination, ['destination.md']);
    });
    try { await act(async () => { await checkSelectedSessionOwner(session.id, A); }); } finally { stop(); }
    expect(wrote).toBe(true); expect(useSessionUIStore.getState().currentSessionDirectory).toBe(B);
    await act(async () => { await sleep(300); });
    expect(c.text()).toContain(text); highlighted(c);
    expect(readChatDraft(c.identity(B)).text).toBe(destination);
    expect(c.prompts()).toHaveLength(1);
    await act(async () => { first.resolve(new Response(null, { status: 204 })); await sleep(20); window.dispatchEvent(new Event('pagehide')); });
    expect(c.text().trim()).toBe(persist ? destination : '');
    expect(readChatDraft(c.identity(B))).toEqual({ text: destination, confirmedMentions: new Set(['destination.md']) });
    expect(c.prompts()).toHaveLength(1);
  });
}

for (const exit of ['shown', 'offscreen'] as const) test(`protected destination survives late accepted cleanup ${exit}`, async () => {
  const c = await conflict(), response = deferred<Response>();
  sendUnconfirmed.ms = 5; c.handlers.prompt = async () => response.promise;
  await c.submit(); expect(c.prompts()).toHaveLength(1);
  if (exit === 'offscreen') await act(async () => useSessionUIStore.setState({ currentSessionId: 'unrelated', currentSessionDirectory: B }));
  await settle();
  if (exit === 'shown') expect(c.text()).toBe(c.retainedText);
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await sleep(20); });
  expect(c.text()).toBe('');
  expect(readChatDraft(c.identity(A)).text).toBe('');
  expect(readChatDraft(c.identity(B))).toEqual({ text: 'Concurrent destination @destination.md', confirmedMentions: new Set(['destination.md']) });
  expect(getSafeStorage().getItem('openchamber.chatDrafts.v2')).toBe(c.bytes);
  expect(c.prompts()).toHaveLength(1); expect(c.creates()).toHaveLength(0);
});
