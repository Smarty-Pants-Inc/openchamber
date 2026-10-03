import { expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { optimisticMessageRecords } from './unsaved';
import { buildSessionMessageRecordsSnapshot } from './sync-context';

// smarty-code#1107: one accepted Send shows one user bubble while its client ID is not bound to its native entry yet.
const T = 1_790_000_000_000;
const user = (id: string, opts: {
  optimistic?: boolean; created?: number; sessionID?: string;
  metadata?: { smartyCodeEchoOf?: string | number | boolean | null | string[] | { clientID: string }; smartyCodeUnsaved?: boolean; smartyCodeRevision?: number };
} = {}) => {
  const info: Extract<Message, { role: 'user' }> & Pick<typeof opts, 'metadata'> = {
    id, sessionID: opts.sessionID ?? 's', role: 'user', time: { created: T + (opts.created ?? 0) },
    agent: 'build', model: { providerID: 'test', modelID: 'test' }, metadata: opts.metadata,
  };
  if (opts.optimistic) optimisticMessageRecords.add(info);
  return info;
};
const text = (messageID: string, value: string): Part[] => [{ id: `${messageID}-p`, messageID, sessionID: 's', type: 'text', text: value }];
const snapshot = (messages: Message[], parts: Record<string, Part[]>, previous?: ReturnType<typeof buildSessionMessageRecordsSnapshot>) =>
  buildSessionMessageRecordsSnapshot({
    status: 'complete', agent: [], command: [], project: '', projectMeta: undefined, icon: undefined,
    provider: { all: [], default: {}, connected: [] }, config: {},
    path: { home: '', state: '', config: '', worktree: '', directory: '' },
    session: [], sessionTotal: 0, session_status: {}, session_diff: {}, todo: {}, permission: {}, question: {},
    mcp: {}, lsp: [], vcs: undefined, limit: 100, message: { s: messages }, part: parts,
  }, 's', previous);
const shown = (messages: Message[], parts: Record<string, Part[]>) => snapshot(messages, parts).list.map((r) => r.info.id);

test('the native entry of this Send (shown under its native id until its client ID is bound) takes its optimistic bubble\'s place', () => {
  const mine = user('msg_client', { optimistic: true, created: 0 }), native = user('abcd1234', { created: 900, metadata: { smartyCodeEchoOf: 'msg_client' } });
  expect(shown([mine, native], { msg_client: text('msg_client', 'Reply with only ok.'), abcd1234: text('abcd1234', 'Reply with only ok.') }))
    .toEqual(['abcd1234']);
});

test('counterexamples: another text, an earlier message of the same text, and no native entry yet all keep the optimistic bubble', () => {
  const a = user('msg_a', { optimistic: true, created: 0 }), other = user('n1', { created: 900 });
  expect(shown([a, other], { msg_a: text('msg_a', 'hello'), n1: text('n1', 'something else') })).toEqual(['msg_a', 'n1']);
  const b = user('msg_b', { optimistic: true, created: 0 }), saved = user('n2', { created: -120_000 });
  expect(shown([saved, b], { msg_b: text('msg_b', 'same'), n2: text('n2', 'same') })).toEqual(['n2', 'msg_b']);
  const c = user('msg_c', { optimistic: true, created: 0 });
  expect(shown([c], { msg_c: text('msg_c', 'alone') })).toEqual(['msg_c']);
});

test('an already shown unbound native yes from ten seconds earlier cannot hide a new same-text Send', () => {
  const earlier = user('native_earlier_yes', { created: -10_000 });
  const parts = { native_earlier_yes: text('native_earlier_yes', 'yes') };
  expect(shown([earlier], parts)).toEqual(['native_earlier_yes']);

  const mine = user('msg_new_yes', { optimistic: true, created: 0 });
  expect(shown([earlier, mine], { ...parts, msg_new_yes: text('msg_new_yes', 'yes') }))
    .toEqual(['native_earlier_yes', 'msg_new_yes']);
});

test('an unlinked concurrent native yes cannot hide my pending Send while its own identity is unknown', () => {
  const mine = user('msg_pending_yes', { optimistic: true, created: 0 });
  const parts = { msg_pending_yes: text('msg_pending_yes', 'yes') };
  // No own native entry or send outcome is known yet; the pending bubble remains visible.
  expect(shown([mine], parts)).toEqual(['msg_pending_yes']);

  const unrelated = user('native_concurrent_yes', { created: 900 });
  // Same text and nearby time are not evidence that this unrelated entry belongs to my Send.
  expect(shown([mine, unrelated], { ...parts, native_concurrent_yes: text('native_concurrent_yes', 'yes') }))
    .toEqual(['msg_pending_yes', 'native_concurrent_yes']);
});

test('two identical Sends in a row: an earlier Send\'s bound record never hides the next one; one native entry replaces one bubble', () => {
  // The first 'yes' is bound (its record is under its client ID); the second is still optimistic, its entry not shown yet.
  const first = user('msg_0001yes', { created: 0 }), second = user('msg_0002yes', { optimistic: true, created: 2_000 });
  const parts = { msg_0001yes: text('msg_0001yes', 'yes'), msg_0002yes: text('msg_0002yes', 'yes') };
  expect(shown([first, second], parts)).toEqual(['msg_0001yes', 'msg_0002yes']);
  // Two optimistic 'yes' and one positively linked native entry: only its own bubble gives way.
  const a = user('msg_a1', { optimistic: true, created: 0 }), b = user('msg_b1', { optimistic: true, created: 1_000 }), n = user('n0000001', { created: 1_500, metadata: { smartyCodeEchoOf: 'msg_a1' } });
  expect(shown([a, b, n], { msg_a1: text('msg_a1', 'yes'), msg_b1: text('msg_b1', 'yes'), n0000001: text('n0000001', 'yes') }))
    .toEqual(['msg_b1', 'n0000001']);
});

test('B echoes before A: one same-text native row hides only B, then two native bubbles remain', () => {
  const a = user('msg_A', { optimistic: true }), b = user('msg_B', { optimistic: true, created: 1_000 });
  const nb = user('native_B', { created: 1_500, metadata: { smartyCodeEchoOf: 'msg_B' } });
  const parts = { msg_A: text('msg_A', 'yes'), msg_B: text('msg_B', 'yes'), native_B: text('native_B', 'yes') };
  const first = snapshot([a, b, nb], parts);
  expect(first.list.map((r) => r.info.id)).toEqual(['msg_A', 'native_B']);
  const na = user('native_A', { created: 2_000, metadata: { smartyCodeEchoOf: 'msg_A' } });
  const next = snapshot([a, b, nb, na], { ...parts, native_A: text('native_A', 'yes') }, first);
  expect(next.list.map((r) => r.info.id)).toEqual(['native_B', 'native_A']);
});

test('association on a text part instead of user info metadata is unsupported and keeps pending', () => {
  const mine = user('msg_pending', { optimistic: true }), native = user('native_part', { created: 900 });
  const nativeParts = text('native_part', 'yes').map((p) => ({ ...p, metadata: { smartyCodeEchoOf: 'msg_pending' } }));
  expect(shown([mine, native], { msg_pending: text('msg_pending', 'yes'), native_part: nativeParts }))
    .toEqual(['msg_pending', 'native_part']);
});

const invalidAssociations = [
  { label: 'missing field', value: undefined }, { label: 'empty', value: '' },
  { label: 'too long', value: 'x'.repeat(257) }, { label: 'number', value: 42 },
  { label: 'boolean', value: true }, { label: 'null', value: null },
  { label: 'array', value: ['msg_pending'] }, { label: 'object', value: { clientID: 'msg_pending' } },
  { label: 'different client id', value: 'msg_someone_else' },
];
for (const { label, value } of invalidAssociations) {
  test(`${label} association keeps both same-text nearby bubbles`, () => {
    const mine = user('msg_pending', { optimistic: true });
    const native = user('native_unknown', { created: 900, metadata: { smartyCodeEchoOf: value } });
    expect(shown([mine, native], { msg_pending: text('msg_pending', 'yes'), native_unknown: text('native_unknown', 'yes') }))
      .toEqual(['msg_pending', 'native_unknown']);
  });
}

test('an exact client id on a native row from the wrong session keeps the pending Send', () => {
  const mine = user('msg_pending', { optimistic: true });
  const foreign = user('native_foreign', { sessionID: 'other', created: 900, metadata: { smartyCodeEchoOf: 'msg_pending' } });
  expect(shown([mine, foreign], { msg_pending: text('msg_pending', 'yes'), native_foreign: text('native_foreign', 'yes') }))
    .toEqual(['msg_pending', 'native_foreign']);
});

test('positive metadata before its native row arrives cannot hide pending; row arrival completes handoff', () => {
  const mine = user('msg_pending', { optimistic: true });
  const native = user('native_later', { created: 900, metadata: { smartyCodeEchoOf: 'msg_pending' } });
  const parts = { msg_pending: text('msg_pending', 'yes'), native_later: text('native_later', 'yes') };
  // A part carrying the association without its user info row is not a positive receipt in the list.
  parts.native_later = parts.native_later.map((p) => ({ ...p, metadata: native.metadata }));
  const before = snapshot([mine], parts);
  expect(before.list.map((r) => r.info.id)).toEqual(['msg_pending']);
  expect(snapshot([mine, native], parts, before).list.map((r) => r.info.id)).toEqual(['native_later']);
});

test('native row before positive metadata keeps both; metadata update hides only the linked pending bubble', () => {
  const mine = user('msg_pending', { optimistic: true }), native = user('native_first', { created: 900 });
  const parts = { msg_pending: text('msg_pending', 'yes'), native_first: text('native_first', 'yes') };
  const before = snapshot([mine, native], parts);
  expect(before.list.map((r) => r.info.id)).toEqual(['msg_pending', 'native_first']);
  const linked = { ...native, metadata: { smartyCodeEchoOf: 'msg_pending' } };
  expect(snapshot([mine, linked], parts, before).list.map((r) => r.info.id)).toEqual(['native_first']);
});

test('positive identity does not depend on text or clock proximity, including a 256-character client id', () => {
  const id = `msg_${'x'.repeat(252)}`, mine = user(id, { optimistic: true });
  const native = user('native_exact', { created: -120_000, metadata: { smartyCodeEchoOf: id } });
  expect(shown([native, mine], { [id]: text(id, 'yes'), native_exact: text('native_exact', 'transformed text') }))
    .toEqual(['native_exact']);
});

test('display suppression preserves native id, save/revision metadata, source rows and optimistic WeakSet', () => {
  const mine = user('msg_pending', { optimistic: true, metadata: { smartyCodeUnsaved: true } });
  const native = user('native_saved', { created: 900, metadata: { smartyCodeEchoOf: 'msg_pending', smartyCodeUnsaved: false, smartyCodeRevision: 7 } });
  const messages = [mine, native], parts = { msg_pending: text('msg_pending', 'yes'), native_saved: text('native_saved', 'yes') };
  const metadata = native.metadata, pendingMetadata = mine.metadata;
  const result = snapshot(messages, parts);
  expect(result.list.map((r) => r.info.id)).toEqual(['native_saved']);
  expect(result.list[0]?.info).toBe(native);
  expect(result.list[0]?.parts).toBe(parts.native_saved);
  expect(result.sourceMessages).toBe(messages);
  expect(messages).toEqual([mine, native]);
  expect(result.byId.get('msg_pending')?.info).toBe(mine);
  expect(native.id).toBe('native_saved');
  expect(native.metadata).toBe(metadata);
  expect(native.metadata).toEqual({ smartyCodeEchoOf: 'msg_pending', smartyCodeUnsaved: false, smartyCodeRevision: 7 });
  expect(mine.metadata).toBe(pendingMetadata);
  expect(mine.metadata).toEqual({ smartyCodeUnsaved: true });
  expect(optimisticMessageRecords.has(mine)).toBe(true);
  expect(optimisticMessageRecords.has(native)).toBe(false);
});
