import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import type { TextPart, UserMessage } from '@opencode-ai/sdk/v2';
import { HumanAuthor } from '@/components/auth/HumanAuthor';
import { trustedHumanAuthor } from '@/components/auth/human-author-data';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE, type State } from '@/sync/types';
import { areOptionalRenderRelevantMessagesEqual, areRenderRelevantMessagesEqual } from './renderCompare';

type Author = NonNullable<ReturnType<typeof trustedHumanAuthor>>;
type MessageRecord = Parameters<typeof areRenderRelevantMessagesEqual>[0];
const author: Author = { version: 1, issuer: 'https://identity.example.test', subject: 'person-1', name: 'Person One' };
const parts: TextPart[] = [{ id: 'prt_675', messageID: 'msg_675', sessionID: 'ses_675', type: 'text', text: 'same steer' }];
const record = <T,>(metadata?: T) => ({
  info: { id: 'msg_675', sessionID: 'ses_675', role: 'user', time: { created: 101 }, agent: 'build',
    model: { providerID: 'test', modelID: 'test' }, metadata } satisfies UserMessage & { metadata?: T },
  parts,
});
const authored = (value = author) => record({ smartyCodeHuman: value });

for (const [label, before, after] of [
  ['addition', record(), authored()],
  ['name change', authored(), authored({ ...author, name: 'Recorded new name' })],
  ['image addition', authored(), authored({ ...author, image: 'https://images.example.test/one.png' })],
  ['image change', authored({ ...author, image: 'https://images.example.test/one.png' }),
    authored({ ...author, image: 'https://images.example.test/two.png' })],
  ['image removal', authored({ ...author, image: 'https://images.example.test/one.png' }), authored()],
  ['subject change', authored(), authored({ ...author, subject: 'person-2' })],
  ['issuer change', authored(), authored({ ...author, issuer: 'https://other.example.test' })],
  ['removal', authored(), record()],
] satisfies [string, MessageRecord, MessageRecord][]) {
  test(`same-ID author ${label} invalidates both message comparators`, () => {
    expect(before.parts).toBe(after.parts);
    expect(areRenderRelevantMessagesEqual(before, after)).toBe(false);
    expect(areRenderRelevantMessagesEqual(after, before)).toBe(false);
    expect(areOptionalRenderRelevantMessagesEqual(before, after)).toBe(false);
  });
}

test('equivalent decoded authors and unrelated metadata preserve equality', () => {
  const equivalent: Author = { name: author.name, subject: author.subject, issuer: author.issuer, version: 1 };
  const before = authored();
  const after = record({ smartyCodeRevision: 99, smartyCodeDisplayName: 'Not the author',
    unrelated: { changed: true }, smartyCodeHuman: equivalent });
  expect(before.info).not.toBe(after.info);
  expect(areRenderRelevantMessagesEqual(before, after)).toBe(true);
  expect(areRenderRelevantMessagesEqual(before, { ...after, parts: parts.map(part => ({ ...part })) })).toBe(true);
  expect(areOptionalRenderRelevantMessagesEqual(undefined, undefined)).toBe(true);
  expect(areOptionalRenderRelevantMessagesEqual(before, undefined)).toBe(false);
});

const malformed = [null, 'Person One', {}, { name: author.name }, { ...author, version: 2 },
  { ...author, subject: '' }, { ...author, issuer: 'https://identity.example.test/path' },
  { ...author, name: '<admin>' }, { ...author, image: 'javascript:alert(1)' },
  { ...author, displayName: 'Pretend author' }];
test('malformed authors are unlabeled, but replacing a valid author with one invalidates', () => {
  for (const value of malformed) {
    const invalid = record({ smartyCodeHuman: value });
    expect(trustedHumanAuthor(invalid.info)).toBeUndefined();
    expect(HumanAuthor({ info: invalid.info })).toBeNull();
    expect(areRenderRelevantMessagesEqual(record(), invalid)).toBe(true);
    expect(areRenderRelevantMessagesEqual(authored(), invalid)).toBe(false);
    expect(areRenderRelevantMessagesEqual(invalid, authored())).toBe(false);
  }
  expect(areRenderRelevantMessagesEqual(record(), record({ smartyCodeDisplayName: author.name }))).toBe(true);
});

test('existing ID, text, agent and unsaved comparisons still invalidate', () => {
  const before = authored();
  for (const after of [
    { ...before, info: { ...before.info, id: 'msg_other' } },
    { ...before, info: { ...before.info, agent: 'plan' } },
    { ...before, parts: [{ ...parts[0], text: 'changed steer' }] },
    record({ smartyCodeHuman: author, smartyCodeUnsaved: true }),
  ]) expect(areRenderRelevantMessagesEqual(before, after)).toBe(false);
  expect(areRenderRelevantMessagesEqual(before, before)).toBe(true);
});

async function mount(initial: MessageRecord) {
  // happy-dom is an in-memory host, not a browser or live session. No external image can be fetched.
  const win = new Window({ url: 'http://localhost', settings: { disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
  const values = { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const root = createRoot(container);
  let renders = 0;
  const Row = React.memo(({ message }: { message: MessageRecord }) => {
    renders++;
    return <div data-message-id={message.info.id}><HumanAuthor info={message.info} /></div>;
  }, (left, right) => areRenderRelevantMessagesEqual(left.message, right.message));
  let state: State = { ...INITIAL_STATE, message: { [initial.info.sessionID]: [initial.info] },
    part: { [initial.info.id]: initial.parts } };
  const show = async () => {
    const message = { info: state.message[initial.info.sessionID][0], parts: state.part[initial.info.id] };
    await act(async () => root.render(<Row key={message.info.id} message={message} />));
  };
  await show();
  return {
    container, renders: () => renders,
    async update(next: MessageRecord) {
      const draft = { ...state, message: { ...state.message } };
      applyDirectoryEvent(draft, { id: 'evt_675', type: 'message.updated', properties: { sessionID: next.info.sessionID, info: next.info } });
      state = draft;
      expect(state.message[next.info.sessionID]).toHaveLength(1);
      expect(trustedHumanAuthor(state.message[next.info.sessionID][0])).toEqual(trustedHumanAuthor(next.info));
      expect(state.part[initial.info.id]).toBe(initial.parts);
      await show();
    },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
      await win.happyDOM.close();
    },
  };
}

for (const [label, before, after, text, image] of [
  ['addition', record(), authored(), author.name, null],
  ['name change', authored(), authored({ ...author, name: 'Recorded new name' }), 'Recorded new name', null],
  ['image change', authored({ ...author, image: 'https://images.example.test/one.png' }),
    authored({ ...author, image: 'https://images.example.test/two.png' }), author.name, 'https://images.example.test/two.png'],
  ['removal', authored(), record(), '', null],
  ['malformed replacement', authored(), record({ smartyCodeHuman: { name: 'Pretend author' } }), '', null],
] satisfies [string, MessageRecord, MessageRecord, string, string | null][]) {
  test(`mounted HumanAuthor follows metadata-only message.updated ${label} through the chat comparator`, async () => {
    const f = await mount(before);
    try {
      await f.update(after);
      expect(f.container.textContent).toBe(text);
      expect(f.container.querySelector('img')?.getAttribute('src') ?? null).toBe(image);
      expect(f.container.querySelectorAll('[data-message-id]')).toHaveLength(1);
      expect(f.renders()).toBe(2);
    } finally { await f.close(); }
  });
}

test('mounted equivalent authors and unrelated updates do not re-render or remount', async () => {
  const f = await mount(authored());
  try {
    const row = f.container.firstChild;
    for (let revision = 1; revision <= 20; revision++) {
      const equivalent: Author = { name: author.name, version: 1, subject: author.subject, issuer: author.issuer };
      await f.update(record({ smartyCodeHuman: equivalent, smartyCodeRevision: revision, unrelated: revision }));
    }
    expect(f.container.textContent).toBe(author.name);
    expect(f.container.firstChild).toBe(row);
    expect(f.renders()).toBe(1);
  } finally { await f.close(); }
});

test('prefix text and displayName never supply a mounted author label', async () => {
  const before = record();
  const untrusted = { ...before, info: { ...before.info, displayName: author.name },
    parts: [{ ...parts[0], text: '**Person One (in Code):** same steer' }] };
  const f = await mount(untrusted);
  try {
    expect(f.container.textContent).toBe('');
    expect(f.container.querySelector('img')).toBeNull();
  } finally { await f.close(); }
});

test('mounted malformed and legacy-name metadata never creates an author label', async () => {
  const f = await mount(record());
  try {
    for (const value of malformed) await f.update(record({ smartyCodeHuman: value }));
    await f.update(record({ smartyCodeDisplayName: author.name }));
    expect(f.container.textContent).toBe('');
    expect(f.container.querySelector('img')).toBeNull();
    expect(f.renders()).toBe(1);
  } finally { await f.close(); }
});
