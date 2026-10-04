import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';
import { btwPanelSpy, errors, mountedNativeComposer } from '../composer/submit/__tests__/nativeComposer.fixture';
import * as btwPanel from '../btw/useBtwPanelState';
import { ChatColumnSessionContext, type ChatColumnSession } from '../chatColumnSession';
import { wrapMarkdownSelectionForChat } from './selectionMarkdown';
import { directory } from '@/sync/native-draft-fixture';
import { useSyncRuntime } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useBtwStore } from '@/stores/useBtwStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { registerSessionDirectory } from '@/sync/sync-refs';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getBtwOriginalSessionID, getBtwSessionID } from '@/lib/sessionBtwMetadata';
import { invokeActiveSelectionAddToChat } from '@/lib/addSelectionToChat';

const { ChatInput } = await import('../ChatInput');
const { TextSelectionMenu } = await import('./TextSelectionMenu');
const inactivePanel: ReturnType<typeof btwPanel.useBtwPanelState> = {
  collapsed: true, btwSessionId: null, btwDirectory: null, parentSession: null,
  btwSession: null, boundaryMessageID: null, creating: false, pending: false,
};
let receiverSpy = btwPanelSpy;

const parentA: Session = { id: 'selection-parent-a', directory, slug: 'a', projectID: 'a',
  title: 'A', version: '1', time: { created: 1, updated: 1 } };
const parentB: Session = { ...parentA, id: 'selection-parent-b', directory: '/native-project-b', title: 'B' };
const metadataSchema = z.object({ openchamber: z.object({
  kind: z.string().optional(), originalSessionID: z.string().optional(),
  btwBoundaryMessageID: z.string().nullable().optional(), btwSessionID: z.string().optional(),
}).optional() });
const patchSchema = z.object({ metadata: metadataSchema.optional(), title: z.string().optional() });
const promptSchema = z.object({ parts: z.array(z.object({ type: z.string(), text: z.string().optional() })) });
type HttpSession = Session & { metadata?: z.infer<typeof metadataSchema> };
type SyncRuntime = ReturnType<typeof useSyncRuntime>;
const globals: typeof globalThis & {
  __openchamber_sync_context__?: React.Context<(SyncRuntime & { directory: string }) | null>;
  __openchamber_sync_runtime_context__?: React.Context<SyncRuntime | null>;
} = globalThis;
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
const initialBtw = useBtwStore.getState();
const originalText = Object.getOwnPropertyDescriptor(globalThis, 'Text');
const originalNodeFilter = Object.getOwnPropertyDescriptor(globalThis, 'NodeFilter');
afterEach(async () => {
  await mounted?.dispose(); mounted = undefined;
  useBtwStore.setState(initialBtw, true);
  receiverSpy = spyOn(btwPanel, 'useBtwPanelState');
  receiverSpy.mockReturnValue(inactivePanel);
  if (originalNodeFilter) Object.defineProperty(globalThis, 'NodeFilter', originalNodeFilter);
  else Reflect.deleteProperty(globalThis, 'NodeFilter');
  if (originalText) Object.defineProperty(globalThis, 'Text', originalText);
  else Reflect.deleteProperty(globalThis, 'Text');
});

async function selectionComposer(mobile = false) {
  receiverSpy.mockRestore();
  let column: ChatColumnSession = { sessionId: parentA.id, directory };
  const sessions = new Map<string, HttpSession>([[parentA.id, parentA], [parentB.id, parentB]]);
  const forkRequests: Request[] = [];
  const mutations: Request[] = [];
  let fixtureFetch: typeof fetch;
  function Surface() {
    const ref = React.useRef<HTMLElement>(null);
    return <><article ref={ref} data-message-id={`message-${column.sessionId}`}>
      <p data-selection-source>{column.sessionId === parentB.id ? 'Quotation from B' : 'Quotation from A'}</p>
    </article><TextSelectionMenu containerRef={ref} /><ChatInput /></>;
  }
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, fixture => {
    const System = globals.__openchamber_sync_context__;
    const Runtime = globals.__openchamber_sync_runtime_context__;
    if (!System || !Runtime) throw new Error('Actual sync context seam missing');
    const value: SyncRuntime = { childStores: fixture.children, messageLoader: fixture.loader,
      sdk: opencodeClient.getSdkClient(), runtimeKey: getRuntimeKey(),
      currentDirectory: { get: () => column.directory ?? directory, subscribe: () => () => {} } };
    return <System.Provider value={{ ...value, directory: column.directory ?? directory }}>
      <Runtime.Provider value={value}><ChatColumnSessionContext.Provider value={column}>
        <Surface />
      </ChatColumnSessionContext.Provider></Runtime.Provider>
    </System.Provider>;
  }, fixture => {
    useBtwStore.setState({ byParent: {} });
    useSessionUIStore.setState(state => ({ currentSessionId: parentA.id, currentSessionDirectory: directory,
      newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, pendingBtwComposerRequest: null,
      pendingSyntheticParts: null, attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map() });
    for (const parent of [parentA, parentB]) {
      const child = fixture.children.ensureChild(parent.directory, { bootstrap: false });
      child.getState().patch({ session: [parent], session_status: { [parent.id]: { type: 'idle' } } });
      registerSessionDirectory(parent.id, parent.directory);
    }
    fixtureFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.hostname !== 'synthetic.invalid') throw new Error('Unexpected network target');
      const match = url.pathname.match(/\/session\/([^/]+)(?:\/(fork))?$/);
      if (match?.[2] && request.method === 'POST') {
        forkRequests.push(request.clone());
        const parent = sessions.get(match[1]);
        if (!parent || url.searchParams.get('directory') !== parent.directory) throw new Error('Wrong fork owner');
        const fork = { ...parent, id: `fork-${parent.id}` };
        sessions.set(fork.id, fork);
        return Response.json(fork);
      }
      if (match && request.method === 'GET') return Response.json(sessions.get(match[1]));
      if (match && request.method === 'PATCH') {
        mutations.push(request.clone());
        const parent = sessions.get(match[1]);
        if (!parent) throw new Error('Unknown metadata owner');
        const updated = { ...parent, ...patchSchema.parse(await request.json()) };
        sessions.set(updated.id, updated);
        return Response.json(updated);
      }
      if (url.pathname.includes('/permission-auto-accept')) return Response.json({ sessions: {}, revision: 1 });
      return fixtureFetch(input, init);
    };
  });
  Object.defineProperty(globalThis, 'Text', { value: c.dom.window.Text, configurable: true });
  Object.defineProperty(globalThis, 'NodeFilter', { value: c.dom.window.NodeFilter, configurable: true });
  await act(async () => { useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' }); });
  await c.replace('Keep the normal draft A');
  if (mobile) {
    const { useUIStore } = await import('@/stores/useUIStore');
    await act(async () => { useUIStore.setState({ isMobile: true, isExpandedInput: true }); });
  }
  const click = async (title: string) => act(async () => {
    const button = [...document.querySelectorAll('button')].find(node => node.title === title);
    if (!button) throw new Error(`Actual selection button missing: ${title}`);
    button.click(); await sleep(0);
  });
  const select = async () => {
    await act(async () => { await sleep(20); });
    await act(async () => {
      const node = c.dom.container.querySelector('[data-selection-source]');
      if (!node) throw new Error('Displayed quote missing');
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection();
      if (!selection) throw new Error('Native selection missing');
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange')); await sleep(0);
    });
    expect([...document.querySelectorAll('button')].some(node => node.title === 'Comment on selection')).toBe(true);
  };
  return { ...c, forkRequests, mutations, sessions, select, click,
    liveB: async () => act(async () => {
      useSessionUIStore.setState({ currentSessionId: parentB.id, currentSessionDirectory: parentB.directory });
      useDirectoryStore.setState({ currentDirectory: parentB.directory }); c.rerender(); await sleep(20);
      useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    }),
    display: async (next: ChatColumnSession) => act(async () => { column = next; c.rerender(); await sleep(0); }),
    settle: async () => act(async () => { await sleep(20); }),
  };
}

for (const mobile of [false, true]) test(`held A/live B Ask sends from A, then displayed B Ask sends from B; mobile ${mobile}`, async () => {
  const c = await selectionComposer(mobile);
  await c.liveB();
  expect(c.dom.container.querySelector('[data-selection-source]')?.textContent).toBe('Quotation from A');
  expect(c.text()).toBe('Keep the normal draft A');
  await c.select(); await c.click('Open a BTW draft with the selection');
  expect(c.text()).toBe(wrapMarkdownSelectionForChat('Quotation from A'));
  expect(useBtwStore.getState().byParent[parentA.id]?.pending).toBe(true);
  expect(useBtwStore.getState().byParent[parentB.id]).toBeUndefined();
  expect(c.forkRequests).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
  await c.submit(); await c.settle();
  expect(errors).toEqual([]);
  expect(c.forkRequests.map(request => new URL(request.url).pathname)).toEqual([`/api/session/${parentA.id}/fork`]);
  expect(c.prompts()).toHaveLength(1);
  expect(new URL(c.prompts()[0].url).pathname).toBe(`/api/session/fork-${parentA.id}/prompt_async`);
  expect(new URL(c.prompts()[0].url).searchParams.get('directory')).toBe(parentA.directory);
  expect(promptSchema.parse(await c.prompts()[0].json()).parts.some(part => part.text === wrapMarkdownSelectionForChat('Quotation from A'))).toBe(true);
  expect(getBtwOriginalSessionID(c.sessions.get(`fork-${parentA.id}`))).toBe(parentA.id);
  expect(getBtwSessionID(c.sessions.get(parentA.id))).toBe(`fork-${parentA.id}`);
  expect(getBtwSessionID(c.sessions.get(parentB.id))).toBeNull();
  expect(useSessionUIStore.getState().currentSessionId).toBe(parentB.id);
  expect(c.creates()).toHaveLength(0);

  await c.display({ sessionId: parentB.id, directory: parentB.directory });
  await c.replace('Keep the normal draft B');
  await act(async () => { useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' }); });
  await c.select(); await c.click('Open a BTW draft with the selection');
  expect(c.text()).toBe(wrapMarkdownSelectionForChat('Quotation from B'));
  expect(c.prompts()).toHaveLength(1);
  await c.submit(); await c.settle();
  expect(errors).toEqual([]);
  expect(c.forkRequests.map(request => new URL(request.url).pathname)).toEqual([
    `/api/session/${parentA.id}/fork`, `/api/session/${parentB.id}/fork`,
  ]);
  expect(c.prompts()).toHaveLength(2);
  expect(new URL(c.prompts()[1].url).pathname).toBe(`/api/session/fork-${parentB.id}/prompt_async`);
  expect(new URL(c.prompts()[1].url).searchParams.get('directory')).toBe(parentB.directory);
  expect(promptSchema.parse(await c.prompts()[1].json()).parts.some(part => part.text === wrapMarkdownSelectionForChat('Quotation from B'))).toBe(true);
  expect(getBtwOriginalSessionID(c.sessions.get(`fork-${parentB.id}`))).toBe(parentB.id);
  expect(c.creates()).toHaveLength(0);
  await c.settle(); expect(c.prompts()).toHaveLength(2); // No automatic ordinary-session replay.
});

for (const change of ['session', 'directory', 'runtime'] as const) test(`a captured quote refuses Ask after its displayed ${change} changes`, async () => {
  const c = await selectionComposer();
  await c.select();
  if (change === 'session') await c.display({ sessionId: parentB.id, directory: parentB.directory });
  if (change === 'directory') await act(async () => {
    c.children.getChild(directory)?.getState().patch({ session: [{ ...parentA, directory: '/moved-a' }] });
    registerSessionDirectory(parentA.id, '/moved-a'); c.rerender();
  });
  if (change === 'runtime') {
    // Change runtime without a render so the captured toolbar still exists.
    await act(async () => {
      c.switchRuntime('selection-other-runtime');
      const button = [...document.querySelectorAll('button')].find(node => node.title === 'Open a BTW draft with the selection');
      if (!button) throw new Error('Captured Ask toolbar missing');
      button.click(); await sleep(0);
    });
    expect(errors).toHaveLength(1);
  } else {
    // The real composer's identity restore focuses its editor and dismisses
    // the native selection. No stale toolbar remains to retarget the quote.
    expect([...document.querySelectorAll('button')].some(node => node.title === 'Open a BTW draft with the selection')).toBe(false);
  }
  expect(useInputStore.getState().pendingBtwComposerRequest).toBeNull();
  expect(c.forkRequests).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
});

test('a displayed column without a parent does not borrow the live sidebar parent', async () => {
  const c = await selectionComposer();
  await c.liveB(); await c.display({ sessionId: null, directory: null }); await c.select();
  expect([...document.querySelectorAll('button')].some(node => node.title === 'Open a BTW draft with the selection')).toBe(false);
  expect(useInputStore.getState().pendingBtwComposerRequest).toBeNull();
  expect(c.forkRequests).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
});

test('copy-to-input and comment IME keep their existing paths without opening or sending BTW', async () => {
  const c = await selectionComposer();
  await c.select(); await act(async () => { expect(invokeActiveSelectionAddToChat()).toBe(true); await sleep(0); });
  expect(c.text()).toContain(wrapMarkdownSelectionForChat('Quotation from A'));
  await c.select(); await c.click('Comment on selection');
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('Actual comment input missing');
  for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })); });
    expect(document.querySelector('textarea')).toBe(textarea);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: parentA.id })).toEqual([]);
  }
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  expect(useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: parentA.id }).map(draft => draft.code)).toEqual(['Quotation from A']);
  expect(useInputStore.getState().pendingBtwComposerRequest).toBeNull();
  expect(c.forkRequests).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
});
