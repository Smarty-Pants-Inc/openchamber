import { afterAll, afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeComposerDom } from '../../submit/__tests__/nativeComposer-dom';
import type { ComposerDraftControls } from '../useComposerDraft';

const dom = nativeComposerDom();
const backing = dom.window.localStorage;
let writeFailure: string | null = null;
let removeBlocked = false;
let writes = 0;
// Happy DOM binds Storage methods through a Proxy. Inject faults through the
// browser storage property instead of installing an ineffective instance spy.
const faultStorage: Storage = {
  getItem: key => backing.getItem(key),
  setItem: (key, value) => {
    writes++;
    if (writeFailure) throw new DOMException('synthetic storage failure', writeFailure);
    backing.setItem(key, value);
  },
  removeItem: key => {
    if (removeBlocked) throw new DOMException('synthetic removal failure', 'SecurityError');
    backing.removeItem(key);
  },
  clear: () => backing.clear(),
  key: index => backing.key(index),
  get length() { return backing.length; },
};
Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: faultStorage });
const { createRoot } = await import('react-dom/client');
const { useComposerDraft } = await import('../useComposerDraft');
const { clearChatDraft, readChatDraft, writeChatDraft } = await import('@/lib/chatDraftPersistence');
const { getSafeStorage } = await import('@/stores/utils/safeStorage');
const storageKey = 'openchamber.chatDrafts.v2';
const identity = { runtimeKey: 'draft-storage-test', directory: '/synthetic', sessionId: 'session' };
let cleanup = () => {};
afterEach(() => { writeFailure = null; removeBlocked = false; cleanup(); getSafeStorage().clear(); writes = 0; });
afterAll(async () => { await dom.restore(); });

function mountDraft(persistEnabled = true) {
  const root = createRoot(dom.container);
  const messageRef = { current: '' }, confirmedMentionsRef = { current: new Set<string>() };
  let controls: ComposerDraftControls | undefined;
  let change: (text: string) => void = () => { throw new Error('Draft not mounted'); };
  function Composer({ enabled }: { enabled: boolean }) {
    const [message, setMessage] = React.useState('');
    change = (text) => { messageRef.current = text; setMessage(text); };
    controls = useComposerDraft({
      message, messageRef, setMessage: change, confirmedMentionsRef, identity,
      persistEnabled: enabled, initialDraft: { text: '', identity },
    });
    return <output data-ephemeral-only={controls.ephemeralOnly}>{message}</output>;
  }
  cleanup = () => { act(() => root.unmount()); };
  act(() => root.render(<Composer enabled={persistEnabled} />));
  return {
    messageRef, confirmedMentionsRef,
    replace: (text: string) => { act(() => change(text)); },
    flush: () => { act(() => window.dispatchEvent(new Event('pagehide'))); },
    unmount: () => { cleanup(); cleanup = () => {}; },
    ephemeralOnly: () => controls?.ephemeralOnly,
  };
}

for (const errorName of ['QuotaExceededError', 'SecurityError']) {
  test(`${errorName} reports memory-only input and retries unchanged text on the next lifecycle edge`, () => {
    const c = mountDraft();
    c.replace('older saved input'); c.flush();
    const oldBytes = backing.getItem(storageKey);
    writeFailure = errorName; removeBlocked = true;
    c.confirmedMentionsRef.current.add('kept.md');
    c.replace('newer live input @kept.md'); c.flush();
    expect(c.ephemeralOnly()).toBe(true);
    expect(c.messageRef.current).toBe('newer live input @kept.md');
    expect(dom.container.textContent).toBe('newer live input @kept.md');
    expect(c.confirmedMentionsRef.current.has('kept.md')).toBe(true);
    expect(readChatDraft(identity).text).toBe(c.messageRef.current);
    expect(backing.getItem(storageKey)).toBe(oldBytes);
    writeFailure = null; removeBlocked = false;
    c.flush();
    expect(c.ephemeralOnly()).toBe(false);
    expect(backing.getItem(storageKey)).toContain('newer live input @kept.md');
  });
}

test('disabled persistence retains live input and mentions without saving them on shutdown', () => {
  const c = mountDraft(false);
  c.confirmedMentionsRef.current.add('kept.md');
  c.replace('only live @kept.md'); c.flush();
  expect(c.messageRef.current).toBe('only live @kept.md');
  expect(c.confirmedMentionsRef.current.has('kept.md')).toBe(true);
  expect(c.ephemeralOnly()).toBe(false);
  c.unmount();
  expect(backing.getItem(storageKey) ?? '').not.toContain('only live');
});

test('disabled persistence does not retry failed deletion on every keystroke', () => {
  writeChatDraft(identity, 'previous draft', []);
  writeFailure = 'SecurityError'; removeBlocked = true;
  const c = mountDraft(false);
  const initialWrites = writes;
  c.replace('first'); c.replace('second'); c.replace('third');
  expect(writes).toBe(initialWrites);
  expect(c.messageRef.current).toBe('third');
  expect(c.ephemeralOnly()).toBe(false);
});

test('unmount writes the latest text and mentions without running timers', () => {
  const c = mountDraft();
  c.confirmedMentionsRef.current.add('kept.md');
  c.replace('last input @kept.md');
  expect(backing.getItem(storageKey) ?? '').not.toContain('last input');
  c.unmount();
  expect(backing.getItem(storageKey)).toContain('last input @kept.md');
  expect(readChatDraft(identity).confirmedMentions.has('kept.md')).toBe(true);
});

test('authoritative deletion cancels pending input so shutdown cannot resurrect it', () => {
  const c = mountDraft();
  c.replace('saved input'); c.flush();
  c.replace('pending replacement');
  act(() => clearChatDraft(identity, true));
  c.flush(); c.unmount();
  expect(readChatDraft(identity).text).toBe('');
  expect(backing.getItem(storageKey)).not.toContain('saved input');
  expect(backing.getItem(storageKey)).not.toContain('pending replacement');
});

test('failed authoritative deletion is reported and retried without restoring deleted text', () => {
  const c = mountDraft();
  c.replace('saved input'); c.flush();
  writeFailure = 'QuotaExceededError'; removeBlocked = true;
  act(() => clearChatDraft(identity, true));
  expect(c.ephemeralOnly()).toBe(true);
  expect(c.messageRef.current).toBe('');
  expect(backing.getItem(storageKey)).toContain('saved input');
  writeFailure = null; removeBlocked = false;
  c.flush();
  expect(c.ephemeralOnly()).toBe(false);
  expect(backing.getItem(storageKey)).not.toContain('saved input');
});

test('another draft write failure invalidates a mounted composer successful-save signature', () => {
  const c = mountDraft();
  c.replace('current input'); c.flush();
  writeFailure = 'QuotaExceededError';
  act(() => { writeChatDraft({ ...identity, sessionId: 'other' }, 'other input', []); });
  expect(c.ephemeralOnly()).toBe(true);
  expect(c.messageRef.current).toBe('current input');
  expect(backing.getItem(storageKey)).toBeNull();
  writeFailure = null;
  c.flush();
  expect(c.ephemeralOnly()).toBe(false);
  expect(backing.getItem(storageKey)).toContain('current input');
  expect(backing.getItem(storageKey)).toContain('other input');
});

test('empty draft retries a deletion that previously only reached memory', () => {
  writeChatDraft(identity, 'old backing input', []);
  writeFailure = 'QuotaExceededError'; removeBlocked = true;
  expect(writeChatDraft(identity, '', [])).toBe(false);
  expect(readChatDraft(identity).text).toBe('');
  expect(backing.getItem(storageKey)).toContain('old backing input');
  writeFailure = null; removeBlocked = false;
  expect(writeChatDraft(identity, '', [])).toBe(true);
  expect(backing.getItem(storageKey)).not.toContain('old backing input');
});

test('typing coalesces backing writes for 500 ms and preserves the last edit', async () => {
  const c = mountDraft();
  c.replace('first'); c.replace('second'); c.replace('last @kept.md');
  c.confirmedMentionsRef.current.add('kept.md');
  expect(writes).toBe(0);
  await act(async () => { await sleep(550); });
  expect(writes).toBe(1);
  expect(backing.getItem(storageKey)).toContain('last @kept.md');
  expect(readChatDraft(identity).confirmedMentions.has('kept.md')).toBe(true);
});

test('unchanged successful lifecycle saves do not write on each event', () => {
  const c = mountDraft();
  c.replace('one snapshot');
  c.flush(); c.flush(); c.flush();
  expect(writes).toBe(1);
  expect(c.ephemeralOnly()).toBe(false);
});
