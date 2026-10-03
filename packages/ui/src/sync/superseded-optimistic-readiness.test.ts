import { expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { optimisticMessageRecords } from './unsaved';
import { buildSessionMessageRecordsSnapshot } from './sync-context';
import { withoutSupersededOptimistic } from './superseded-optimistic';
import type { OptimisticItem } from './optimistic';
import { normalizeUserDisplayParts } from '../components/chat/message/normalizeUserDisplayParts';
import { filterVisibleParts, isEmptyTextPart, normalizeParts } from '../components/chat/message/partUtils';
import { isHiddenUserMessage } from '../components/chat/message/hiddenUserMessage';
import { voiceText } from '../components/chat/message/voiceTurnData';

// Same public builder/WeakSet fixture seams as superseded-optimistic.test.ts; no authority is mocked.
const user = (id: string, echoOf?: string) => {
  const info: Extract<Message, { role: 'user' }> & {
    metadata: { smartyCodeEchoOf?: string; smartyCodeUnsaved: boolean; smartyCodeRevision: number };
  } = {
    id, sessionID: 's', role: 'user', time: { created: 1_790_000_000_000 },
    agent: 'build', model: { providerID: 'test', modelID: 'test' },
    metadata: { smartyCodeEchoOf: echoOf, smartyCodeUnsaved: id === 'pending', smartyCodeRevision: 7 },
  };
  return info;
};
const text = (messageID: string, value: string): Part[] => [
  { id: `${messageID}-p`, messageID, sessionID: 's', type: 'text', text: value },
];
const snapshot = (messages: Message[], parts: Record<string, Part[]>, previous?: ReturnType<typeof buildSessionMessageRecordsSnapshot>) =>
  buildSessionMessageRecordsSnapshot({
    status: 'complete', agent: [], command: [], project: '', projectMeta: undefined, icon: undefined,
    provider: { all: [], default: {}, connected: [] }, config: {},
    path: { home: '', state: '', config: '', worktree: '', directory: '' },
    session: [], sessionTotal: 0, session_status: {}, session_diff: {}, todo: {}, permission: {}, question: {},
    mcp: {}, lsp: [], vcs: undefined, limit: 100, message: { s: messages }, part: parts,
  }, 's', previous);
const fixture = (echoOf = 'pending') => {
  const pending = user('pending'), native = user('native', echoOf);
  optimisticMessageRecords.add(pending);
  const pendingParts = text('pending', 'yes');
  const shadow = { message: pending, parts: pendingParts };
  const optimistic = new Map<string, OptimisticItem>([['pending', shadow]]);
  return { pending, native, pendingParts, shadow, optimistic };
};
const ids = (value: ReturnType<typeof snapshot>) => value.list.map((row) => row.info.id);
// Call the real ChatMessage normalizers; MessageBody separately rejects empty user text.
const displayParts = (parts: Part[]) => filterVisibleParts(
  normalizeUserDisplayParts(normalizeParts(parts), { planModeEnabled: false }), { includeReasoning: true },
);

test('firstInfoThenPart: linked message.updated with no parts keeps pending until message.part.updated', () => {
  const { pending, native, pendingParts, shadow, optimistic } = fixture();
  const pendingMetadata = pending.metadata, nativeMetadata = native.metadata;
  const before = snapshot([pending], { pending: pendingParts });
  const pendingRecord = before.byId.get('pending');
  // Exact order: pending -> native info + positive link, absent part key -> native text part.
  const messages = [pending, native], parts = { pending: pendingParts };
  const infoOnly = snapshot(messages, parts, before);
  expect(infoOnly.byId.get('native')?.parts).toEqual([]); // actual builder's EMPTY_PARTS
  expect(isHiddenUserMessage(infoOnly.byId.get('native'), { planModeEnabled: false })).toBe(true);
  expect(isHiddenUserMessage(pendingRecord, { planModeEnabled: false })).toBe(false);
  expect(infoOnly.byId.get('pending')).toBe(pendingRecord);
  const repeated = snapshot(messages, parts, infoOnly);
  expect(repeated).toBe(infoOnly);
  expect(repeated.list).toBe(infoOnly.list);
  expect(withoutSupersededOptimistic(infoOnly.list)).toBe(infoOnly.list);

  const nativeParts = text('native', 'yes');
  const arrived = snapshot(messages, { ...parts, native: nativeParts }, infoOnly);
  expect(ids(arrived)).toEqual(['native']);
  expect(isHiddenUserMessage(arrived.list[0], { planModeEnabled: false })).toBe(false);
  expect(arrived.list[0]?.info).toBe(native);
  expect(arrived.list[0]?.parts).toBe(nativeParts);
  expect(arrived.byId.get('pending')).toBe(pendingRecord);
  expect(arrived.sourceMessages).toBe(messages);
  expect(messages).toEqual([pending, native]);
  expect(parts).toEqual({ pending: pendingParts });
  expect(native.id).toBe('native');
  expect(native.metadata).toBe(nativeMetadata);
  expect(native.metadata).toEqual({ smartyCodeEchoOf: 'pending', smartyCodeUnsaved: false, smartyCodeRevision: 7 });
  expect(pending.metadata).toBe(pendingMetadata);
  expect(optimistic.get('pending')).toBe(shadow);
  expect([...optimistic.keys()]).toEqual(['pending']);
  expect(shadow.parts).toBe(pendingParts);
  expect(optimisticMessageRecords.has(pending)).toBe(true);
  expect(optimisticMessageRecords.has(native)).toBe(false);
  expect(snapshot(messages, { ...parts, native: nativeParts }, arrived)).toBe(arrived);
  expect(withoutSupersededOptimistic(arrived.list)).toBe(arrived.list);
  // Assert the info-only continuity last so native handoff/preservation checks also execute on RED.
  expect(ids(infoOnly)).toEqual(['pending', 'native']); // RED: current code removes pending here.
  expect(infoOnly.list[0]).toBe(pendingRecord);
});

const base = { id: 'native-p', messageID: 'native', sessionID: 's' };
const nonDisplayable: { label: string; parts: Part[]; hidden: boolean }[] = [
  { label: 'explicit empty parts', parts: [], hidden: true },
  { label: 'empty text', parts: text('native', ''), hidden: false },
  { label: 'whitespace text', parts: text('native', ' \n\t'), hidden: false },
  { label: 'hidden synthetic nudge', parts: [{ ...base, type: 'text', text: 'subagent finished', synthetic: true }], hidden: true },
  { label: 'synthetic reminder', parts: [{ ...base, type: 'text', text: '<system-reminder>wait</system-reminder>', synthetic: true }], hidden: true },
  { label: 'patch only', parts: [{ ...base, type: 'patch', hash: 'hash', files: ['a.ts'] }], hidden: true },
];
for (const { label, parts: nativeParts, hidden } of nonDisplayable) {
  test(`linked ${label} cannot replace the renderable pending user content`, () => {
    const { pending, native, pendingParts } = fixture();
    const messages = [pending, native], parts = { pending: pendingParts, native: nativeParts };
    expect(isHiddenUserMessage({ info: native, parts: nativeParts }, { planModeEnabled: false })).toBe(hidden);
    expect(displayParts(nativeParts).filter((part) => !isEmptyTextPart(part))).toEqual([]);
    const result = snapshot(messages, parts);
    expect(ids(result)).toEqual(['pending', 'native']);
    expect(withoutSupersededOptimistic(result.list)).toBe(result.list);
    expect(snapshot(messages, parts, result)).toBe(result);
    expect(snapshot(messages, parts, result).list).toBe(result.list);
  });
}

test('native voice metadata and a control/unsupported user-body part are not user text', () => {
  const { pending, native, pendingParts } = fixture();
  const voiceNative = { ...native, metadata: { ...native.metadata, smartyVoice: { speaker: 'user' } } };
  // step-start is valid SDK transport data, but is not a UserTextPart or attachment in MessageBody.
  const control: Part[] = [{ ...base, type: 'step-start' }];
  expect(voiceText(control)).toBe('');
  expect(control.every((part) => part.type !== 'text' && part.type !== 'file')).toBe(true);
  const records = snapshot([pending, voiceNative], { pending: pendingParts, native: control });
  expect(ids(records)).toEqual(['pending', 'native']);
  expect(withoutSupersededOptimistic(records.list)).toBe(records.list);
});

test('attachment-only native content is eligible without text, preserving native parts and identity', () => {
  const { pending, native, pendingParts } = fixture();
  const nativeParts: Part[] = [{ ...base, type: 'file', mime: 'image/png', filename: 'photo.png', url: 'data:image/png;base64,AA==' }];
  expect(displayParts(nativeParts)).toEqual(nativeParts);
  const result = snapshot([pending, native], { pending: pendingParts, native: nativeParts });
  expect(ids(result)).toEqual(['native']);
  expect(result.list[0]?.info).toBe(native);
  expect(result.list[0]?.parts).toBe(nativeParts);
  expect(optimisticMessageRecords.has(pending)).toBe(true);
});

test('display-ready native content with an unknown link keeps both and preserves the original list', () => {
  const { pending, native, pendingParts } = fixture('unknown-client');
  const nativeParts = text('native', 'yes');
  const messages = [pending, native], parts = { pending: pendingParts, native: nativeParts };
  const original = [{ info: pending, parts: pendingParts }, { info: native, parts: nativeParts }];
  expect(withoutSupersededOptimistic(original)).toBe(original);
  expect(isHiddenUserMessage(original[1], { planModeEnabled: false })).toBe(false);
  const result = snapshot(messages, parts);
  expect(ids(result)).toEqual(['pending', 'native']);
  expect(withoutSupersededOptimistic(result.list)).toBe(result.list);
  expect(snapshot(messages, parts, result)).toBe(result);
  expect(snapshot(messages, parts, result).list).toBe(result.list);
});
