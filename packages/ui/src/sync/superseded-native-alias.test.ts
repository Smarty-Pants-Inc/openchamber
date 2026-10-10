import { expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { optimisticMessageRecords } from './unsaved';
import { buildSessionMessageRecordsSnapshot } from './sync-context';

// Proposed complete-successor-before-removal overlap, not a producer or paint fixture.
type Metadata = {
  smartyCodeEchoOf?: string | number | boolean | null | string[] | { clientID: string };
  pi?: { entryID?: string | number | null | string[] };
  smartyCodeUnsaved?: boolean;
  smartyCodeRevision?: number;
};
const user = (id: string, metadata?: Metadata, sessionID = 'S', created = 1_790_000_000_000) => {
  const info: Extract<Message, { role: 'user' }> & { metadata?: Metadata } = {
    id, sessionID, role: 'user', time: { created }, agent: 'build',
    model: { providerID: 'test', modelID: 'test' }, metadata,
  };
  return info;
};
const text = (messageID: string, value = 'same', sessionID = 'S'): Part[] => [
  { id: `${messageID}-p`, messageID, sessionID, type: 'text', text: value },
];
const snapshot = (messages: Message[], parts: Record<string, Part[]>, previous?: ReturnType<typeof buildSessionMessageRecordsSnapshot>) =>
  buildSessionMessageRecordsSnapshot({
    status: 'complete', agent: [], command: [], project: '', projectMeta: undefined, icon: undefined,
    provider: { all: [], default: {}, connected: [] }, config: {},
    path: { home: '', state: '', config: '', worktree: '', directory: '' },
    session: [], sessionTotal: 0, session_status: {}, session_diff: {}, todo: {}, permission: {}, question: {},
    mcp: {}, lsp: [], vcs: undefined, limit: 100, message: { S: messages }, part: parts,
  }, 'S', previous);
const ids = (value: ReturnType<typeof snapshot>) => value.list.map((row) => row.info.id);
const rawMetadata = (): Metadata => ({ smartyCodeEchoOf: 'C', pi: { entryID: 'E' }, smartyCodeUnsaved: false, smartyCodeRevision: 7 });
const canonicalMetadata = (): Metadata => ({ pi: { entryID: 'E' }, smartyCodeUnsaved: false, smartyCodeRevision: 7 });

const invalid: { label: string; raw?: Metadata; canonical?: Metadata; canonicalID?: string; rawSession?: string; canonicalSession?: string }[] = [
  { label: 'missing raw metadata', raw: undefined },
  { label: 'missing canonical metadata', canonical: undefined },
  { label: 'missing raw pi', raw: { smartyCodeEchoOf: 'C' } },
  { label: 'missing canonical pi', canonical: {} },
  { label: 'missing raw entry', raw: { smartyCodeEchoOf: 'C', pi: {} } },
  { label: 'missing canonical entry', canonical: { pi: {} } },
  { label: 'different raw entry', raw: { smartyCodeEchoOf: 'C', pi: { entryID: 'other' } } },
  { label: 'different canonical entry', canonical: { pi: { entryID: 'other' } } },
  { label: 'foreign canonical session', canonicalSession: 'foreign' },
  { label: 'foreign raw session', rawSession: 'foreign' },
  { label: 'canonical id differs from exact link', canonicalID: 'C-other' },
  { label: 'unknown link', raw: { smartyCodeEchoOf: 'absent', pi: { entryID: 'E' } } },
  { label: 'self link', raw: { smartyCodeEchoOf: 'E', pi: { entryID: 'E' } } },
  ...[
    { label: 'empty', value: '' }, { label: 'overlong', value: 'x'.repeat(257) },
    { label: 'number', value: 42 }, { label: 'boolean', value: true }, { label: 'null', value: null },
    { label: 'array', value: ['C'] }, { label: 'object', value: { clientID: 'C' } },
  ].map(({ label, value }) => ({ label: `malformed ${label} link`, raw: { smartyCodeEchoOf: value, pi: { entryID: 'E' } } })),
  { label: 'empty native entry', canonical: { pi: { entryID: '' } } },
  { label: 'numeric native entry', canonical: { pi: { entryID: 42 } } },
  { label: 'null native entry', canonical: { pi: { entryID: null } } },
  { label: 'array native entry', canonical: { pi: { entryID: ['E'] } } },
];
for (const control of invalid) {
  test(`${control.label} cannot suppress raw E`, () => {
    const raw = user('E', 'raw' in control ? control.raw : rawMetadata(), control.rawSession);
    const canonical = user(control.canonicalID ?? 'C', 'canonical' in control ? control.canonical : canonicalMetadata(), control.canonicalSession);
    const messages = [raw, canonical], parts = { E: text('E', 'same', raw.sessionID), [canonical.id]: text(canonical.id, 'same', canonical.sessionID) };
    const result = snapshot(messages, parts);
    expect(ids(result)).toEqual(['E', canonical.id]);
    expect(result.sourceMessages).toBe(messages);
    expect(result.byId.get('E')?.info).toBe(raw);
    expect(result.byId.get('E')?.parts).toBe(parts.E);
  });
}

test('distinct identical-text native entries at identical times retain two bubbles', () => {
  const a = user('E1', { pi: { entryID: 'E1' } }), b = user('E2', { pi: { entryID: 'E2' } });
  expect(ids(snapshot([a, b], { E1: text('E1'), E2: text('E2') }))).toEqual(['E1', 'E2']);
});

const base = { id: 'C-p', messageID: 'C', sessionID: 'S' };
const notReady: { label: string; parts?: Part[] }[] = [
  { label: 'absent parts' }, { label: 'empty parts', parts: [] },
  { label: 'empty text', parts: text('C', '') }, { label: 'whitespace', parts: text('C', ' \n\t') },
  { label: 'only reasoning', parts: [{ ...base, type: 'reasoning', text: 'thinking', time: { start: 1, end: 2 } }] },
  { label: 'unsupported user-body control', parts: [{ ...base, type: 'step-start' }] },
];
for (const control of notReady) {
  test(`linked canonical ${control.label} keeps displayable E`, () => {
    const raw = user('E', rawMetadata()), canonical = user('C', canonicalMetadata());
    const rawParts = text('E'), parts: Record<string, Part[]> = control.parts === undefined ? { E: rawParts } : { E: rawParts, C: control.parts };
    const result = snapshot([raw, canonical], parts);
    expect(ids(result)).toEqual(['E', 'C']);
    expect(result.list[0]?.info).toBe(raw);
    expect(result.list[0]?.parts).toBe(rawParts);
    expect(snapshot(result.sourceMessages, parts, result)).toBe(result);
  });
}

test('first leg still prefers native E over optimistic C without preference inversion', () => {
  const raw = user('E', rawMetadata()), canonical = user('C', canonicalMetadata());
  optimisticMessageRecords.add(canonical);
  try {
    const messages = [canonical, raw], parts = { E: text('E'), C: text('C') };
    const result = snapshot(messages, parts);
    expect(ids(result)).toEqual(['E']);
    expect(result.sourceMessages).toBe(messages);
    expect(result.byId.get('C')?.info).toBe(canonical);
    expect(result.byId.get('C')?.parts).toBe(parts.C);
    expect(optimisticMessageRecords.has(canonical)).toBe(true);
    expect(optimisticMessageRecords.has(raw)).toBe(false);
  } finally {
    optimisticMessageRecords.delete(canonical);
  }
  expect(optimisticMessageRecords.has(canonical)).toBe(false);
});

test('complete same-session canonical C alone is projected while authoritative raw E stays stored', () => {
  const raw = user('E', rawMetadata()), canonical = user('C', canonicalMetadata(), 'S', 1_790_000_120_000);
  const rawParts = text('E', 'original'), canonicalParts = text('C', 'transformed canonical text');
  const before = snapshot([raw], { E: rawParts });
  expect(ids(before)).toEqual(['E']);
  const messages = [raw, canonical], waitingParts = { E: rawParts };
  const waiting = snapshot(messages, waitingParts, before);
  expect(ids(waiting)).toEqual(['E', 'C']);
  expect(waiting.list[0]?.parts).toBe(rawParts);
  const parts = { E: rawParts, C: canonicalParts }, rawMeta = raw.metadata, canonicalMeta = canonical.metadata;
  const result = snapshot(messages, parts, waiting);
  expect(result.sourceMessages).toBe(messages);
  expect(messages).toEqual([raw, canonical]);
  expect(result.byId.size).toBe(2);
  expect(result.byId.get('E')).toBe(before.byId.get('E'));
  expect(result.byId.get('E')?.info).toBe(raw);
  expect(result.byId.get('E')?.parts).toBe(rawParts);
  expect(result.byId.get('C')?.info).toBe(canonical);
  expect(result.byId.get('C')?.parts).toBe(canonicalParts);
  expect(parts.E).toBe(rawParts);
  expect(parts.C).toBe(canonicalParts);
  expect(raw.metadata).toBe(rawMeta);
  expect(canonical.metadata).toBe(canonicalMeta);
  expect(raw.metadata).toEqual(rawMetadata());
  expect(canonical.metadata).toEqual(canonicalMetadata());
  expect(optimisticMessageRecords.has(raw)).toBe(false);
  expect(optimisticMessageRecords.has(canonical)).toBe(false);
  expect(snapshot(messages, parts, result)).toBe(result);
  console.log('native-alias target prerequisites passed; source/byId E+C intact; projection:', JSON.stringify(ids(result)));
  // Sole RED oracle, last: no text/time inference and no authoritative deletion.
  expect(ids(result)).toEqual(['C']);
});

test('an unmarked raw user and its full canonical alias represent the same native entry, not two Sends', () => {
  const raw = user('E', { pi: { entryID: 'E' } }), canonical = user('C', canonicalMetadata());
  const messages = [raw, canonical], parts = { E: text('E'), C: text('C') };
  const result = snapshot(messages, parts);
  expect(result.sourceMessages).toBe(messages);
  expect(result.byId.get('E')?.info).toBe(raw);
  expect(result.byId.get('E')?.parts).toBe(parts.E);
  expect(ids(result)).toEqual(['C']);
});

for (const dParts of [text('D'), []]) test(`competing canonical aliases are UNKNOWN even if one has ${dParts.length} parts`, () => {
  const raw = user('E', rawMetadata()), c = user('C', canonicalMetadata()), d = user('D', canonicalMetadata());
  expect(ids(snapshot([raw, c, d], { E: text('E'), C: text('C'), D: dParts }))).toEqual(['E', 'C', 'D']);
});
