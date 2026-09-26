import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { UnsavedLabel } from './UnsavedLabel';
import { isUnsaved } from '@/sync/unsaved';

// Slice 1 L1: a record Pi holds in memory but has not written to the session file carries
// info.metadata.smartyCodeUnsaved: true; its row shows a small 'Unsaved' label. Absent means saved.
const render = (info: unknown) => renderToStaticMarkup(<I18nProvider><UnsavedLabel info={info} /></I18nProvider>);

test('an unsaved record shows the label with its explanation', () => {
  const html = render({ id: 'm1', metadata: { smartyCodeUnsaved: true } });
  expect(html).toContain('>unsaved<'); // code-controls' slice 1 harness looks for this word.
  expect(html).toContain('title="Pi has this message, but it is not in the session file yet."');
});

test('a saved record, or anything but exactly true, shows nothing', () => {
  for (const info of [{ id: 'm1' }, { metadata: {} }, { metadata: { smartyCodeUnsaved: false } },
    { metadata: { smartyCodeUnsaved: 'true' } }, { metadata: { smartyCodeUnsaved: 1 } }, null, undefined]) {
    expect(isUnsaved(info)).toBe(false);
    expect(render(info)).toBe('');
  }
});

test('both message rows render it: the user bubble (beside the author) and the assistant row', async () => {
  // ChatMessage needs the whole app to mount; like issue-2903's container checks, this reads its source.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./ChatMessage.tsx', import.meta.url), 'utf8');
  expect(/<HumanAuthor info=\{message\.info\} \/>\s*<UnsavedLabel info=\{message\.info\} \/>/.test(source)).toBe(true);
  expect(/<div className="relative">\s*<UnsavedLabel info=\{message\.info\} \/>\s*<MessageBody/.test(source)).toBe(true);
});

// The flag must reach the row through every path and clear when the record is saved (Astra pre-check).
const base = { id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 1, completed: 2 }, finish: 'stop', cost: 0.1 };
const unsaved = { ...base, metadata: { smartyCodeUnsaved: true } };
// The gateway's freshness (smarty-code#401): a record's revision never decreases for the same row.
const at = <T extends object>(revision: number, record: T, unsavedRow = false) =>
  ({ ...record, metadata: { ...(unsavedRow ? { smartyCodeUnsaved: true } : {}), smartyCodeRevision: revision } });

test('a live message.updated that only adds the flag (a new record) or removes it (saved) is applied', async () => {
  const { applyDirectoryEvent } = await import('@/sync/event-reducer');
  const { INITIAL_STATE } = await import('@/sync/types');
  const draft = { ...INITIAL_STATE, message: {}, part: {}, session_status: {} } as never as Parameters<typeof applyDirectoryEvent>[0];
  const update = (info: unknown) => applyDirectoryEvent(draft, { type: 'message.updated', properties: { info } } as never);
  expect(update(unsaved)).toBe(true);
  expect(isUnsaved(draft.message.s1[0])).toBe(true);
  expect(update(base)).toBe(true);
  expect(isUnsaved(draft.message.s1[0])).toBe(false);
});

test('a history page applies a newer save state to a shown record, either way, keeping its other fields; an older one is ignored', async () => {
  const { mergeMessages } = await import('@/sync/optimistic');
  const live = { ...at(1, base, true), cost: 0.2 };
  const saved = mergeMessages([live] as never[], [at(2, base)] as never[]);
  expect(isUnsaved(saved[0])).toBe(false);
  expect((saved[0] as { cost: number }).cost).toBe(0.2);
  // Saved -> unsaved is real too (a tool result that failed to append), when it is newer.
  expect(isUnsaved(mergeMessages(saved, [at(3, base, true)] as never[])[0])).toBe(true);
  // An older page never overrides a newer state, in either direction.
  expect(isUnsaved(mergeMessages(saved, [at(1, base, true)] as never[])[0])).toBe(false);
  const same = [base] as never[];
  expect(mergeMessages(same, [{ ...base }] as never[])).toBe(same);
});

test('a mounted row re-renders when only the flag changes, in both directions', async () => {
  const { areRenderRelevantMessagesEqual } = await import('./message/renderCompare');
  const record = (info: unknown) => ({ info, parts: [] }) as never;
  expect(areRenderRelevantMessagesEqual(record(base), record(unsaved))).toBe(false);
  expect(areRenderRelevantMessagesEqual(record(unsaved), record(base))).toBe(false);
  expect(areRenderRelevantMessagesEqual(record(unsaved), record({ ...unsaved }))).toBe(true);
});

test('an optimistic shadow merged with an older page never clears a flag a live update set', async () => {
  const { mergeMessages } = await import('@/sync/optimistic');
  const { optimisticMessageRecords } = await import('@/sync/unsaved');
  const shadow = { ...base, role: 'user' };
  optimisticMessageRecords.add(shadow);
  const live = { ...shadow, metadata: { smartyCodeUnsaved: true, smartyCodeHuman: { name: 'Kate' } } };
  const merged = mergeMessages([live] as never[], [shadow] as never[]);
  expect(isUnsaved(merged[0])).toBe(true);
  expect((merged[0] as { metadata: { smartyCodeHuman: { name: string } } }).metadata.smartyCodeHuman.name).toBe('Kate');
});

test('a page promotes an optimistic record to the server flag, set or clear', async () => {
  const { mergeMessages } = await import('@/sync/optimistic');
  const { optimisticMessageRecords } = await import('@/sync/unsaved');
  const optimistic = { ...base, role: 'user' };
  optimisticMessageRecords.add(optimistic);
  const promoted = mergeMessages([optimistic] as never[], [{ ...optimistic, metadata: { smartyCodeUnsaved: true } }] as never[]);
  expect(isUnsaved(promoted[0])).toBe(true);
});

test('a stopped reply reconciled from an older page keeps its saved state', async () => {
  const { materializeSessionSnapshots } = await import('@/sync/materialization');
  const saved = { ...at(5, base), time: { created: 1 }, error: { name: 'MessageAbortedError', data: {} } };
  const olderPage = { ...at(4, base, true), time: { created: 1, completed: 3 }, error: { name: 'MessageAbortedError', data: {} } };
  const state = { message: { s1: [saved] }, part: {} } as never;
  const result = materializeSessionSnapshots(state, 's1', [{ info: olderPage as never, parts: [] }]);
  const row = result.message.s1[0] as { time: { completed?: number } };
  expect(isUnsaved(row)).toBe(false);
  expect(row.time.completed).toBe(3);
});

test('a saved confirmation retires the optimistic record, so an older unsaved snapshot cannot bring the label back', async () => {
  const { mergeMessages } = await import('@/sync/optimistic');
  const { optimisticMessageRecords } = await import('@/sync/unsaved');
  const optimistic = { ...base, role: 'user' };
  optimisticMessageRecords.add(optimistic);
  const confirmed = mergeMessages([optimistic] as never[], [at(5, optimistic)] as never[]);
  expect(optimisticMessageRecords.has(confirmed[0])).toBe(false);
  const stale = mergeMessages(confirmed, [at(4, optimistic, true)] as never[]);
  expect(isUnsaved(stale[0])).toBe(false);
});

test('an older buffered live update never un-saves a record a newer snapshot saved; its other fields apply', async () => {
  const { applyDirectoryEvent } = await import('@/sync/event-reducer');
  const { INITIAL_STATE } = await import('@/sync/types');
  const draft = { ...INITIAL_STATE, message: { s1: [at(5, base)] }, part: {}, session_status: {} } as never as Parameters<typeof applyDirectoryEvent>[0];
  expect(applyDirectoryEvent(draft, { type: 'message.updated', properties: { info: { ...at(4, base, true), cost: 0.3 } } } as never)).toBe(true);
  expect(isUnsaved(draft.message.s1[0])).toBe(false);
  expect((draft.message.s1[0] as unknown as { cost: number }).cost).toBe(0.3);
});

test('a reconnect refresh that answers with an older unsaved page does not un-save a record saved meanwhile', async () => {
  const { ChildStoreManager } = await import('@/sync/child-store');
  const { SessionMessageLoader } = await import('@/sync/session-message-loader');
  const { applyDirectoryEvent } = await import('@/sync/event-reducer');
  const view = `ov2_${'a'.repeat(64)}`;
  const record = (saved: boolean) => ({ info: at(saved ? 2 : 1, { ...base, sessionID: 's1' }, !saved),
    parts: [{ id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: 'hi' }] });
  let answer: (records: unknown[]) => void = () => {};
  let calls = 0;
  const sdk = { session: { messages: async () => {
    calls += 1;
    if (calls === 1) return { data: [record(false)], response: new Response(null, { headers: { 'x-smarty-ordinary-view': view } }) };
    const records = await new Promise<unknown[]>((resolve) => { answer = resolve; });
    return { data: records, response: new Response(null, { headers: { 'x-smarty-ordinary-view': view } }) };
  } } };
  const children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk: sdk as never, runtimeKey: 'a' });
  const target = { directory: '/repo', sessionID: 's1' };
  try {
    await loader.ensure(target);
    const store = () => children.getChild('/repo')!;
    expect(isUnsaved(store().getState().message.s1[0])).toBe(true);
    loader.invalidateOrdinaryViews();
    const refresh = loader.refreshOrdinaryView(target, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const draft = { ...store().getState(), message: { ...store().getState().message } };
    applyDirectoryEvent(draft as never, { type: 'message.updated', properties: { info: record(true).info } } as never);
    store().setState({ message: draft.message });
    expect(isUnsaved(store().getState().message.s1[0])).toBe(false);
    answer([record(false)]);
    await refresh;
    expect(isUnsaved(store().getState().message.s1[0])).toBe(false);
  } finally { loader.dispose(); children.disposeAll(); }
});

test('a reconnect refresh whose page lacks a record keeps the server record shown, not the page\'s optimistic shadow', async () => {
  const { ChildStoreManager } = await import('@/sync/child-store');
  const { SessionMessageLoader } = await import('@/sync/session-message-loader');
  const { applyDirectoryEvent } = await import('@/sync/event-reducer');
  const view = `ov2_${'b'.repeat(64)}`;
  let answer: (records: unknown[]) => void = () => {};
  let calls = 0;
  const sdk = { session: { messages: async () => {
    calls += 1;
    if (calls === 1) return { data: [], response: new Response(null, { headers: { 'x-smarty-ordinary-view': view } }) };
    const records = await new Promise<unknown[]>((resolve) => { answer = resolve; });
    return { data: records, response: new Response(null, { headers: { 'x-smarty-ordinary-view': view } }) };
  } } };
  const children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk: sdk as never, runtimeKey: 'a' });
  const target = { directory: '/repo', sessionID: 's1' };
  try {
    await loader.ensure(target);
    const user = { id: 'm1', sessionID: 's1', role: 'user', time: { created: 1 } };
    loader.optimisticAdd({ ...target, message: user as never, parts: [{ id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: 'hi' }] as never });
    loader.invalidateOrdinaryViews();
    const refresh = loader.refreshOrdinaryView(target, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const store = () => children.getChild('/repo')!;
    const draft = { ...store().getState(), message: { ...store().getState().message } };
    applyDirectoryEvent(draft as never, { type: 'message.updated', properties: { info: { ...user, metadata: { smartyCodeUnsaved: true } } } } as never);
    store().setState({ message: draft.message });
    answer([]);
    await refresh;
    expect(isUnsaved(store().getState().message.s1.find((message) => message.id === 'm1'))).toBe(true);
  } finally { loader.dispose(); children.disposeAll(); }
});

test('an ambiguous send confirmed by an older unsaved read keeps a record saved meanwhile', async () => {
  const { create } = await import('zustand');
  const { materializeConfirmedSendRecords } = await import('@/sync/session-actions');
  const saved = at(5, { ...base, sessionID: 's1', role: 'user' });
  const store = create(() => ({ message: { s1: [saved] }, part: { m1: [] } })) as never;
  materializeConfirmedSendRecords(store, 's1', 'm1', [{ info: at(4, { ...base, sessionID: 's1', role: 'user' }, true) as never, parts: [] }]);
  expect(isUnsaved((store as { getState: () => { message: { s1: unknown[] } } }).getState().message.s1[0])).toBe(false);
});

// smarty-code#401 review: the gateway legitimately moves a saved row back to unsaved (a tool result that fails to
// append, or a journal that is replaced). Producer to consumer: saved, then an authoritative unsaved update, then a
// reconnect whose page says the same: the label stays; a stale older page cannot un-save the newer row.
test('a saved row made unsaved by a newer live update keeps the label through a reconnect; an older page cannot clear it', async () => {
  const { ChildStoreManager } = await import('@/sync/child-store');
  const { SessionMessageLoader } = await import('@/sync/session-message-loader');
  const { applyDirectoryEvent } = await import('@/sync/event-reducer');
  const view = `ov2_${'c'.repeat(64)}`;
  const row = (revision: number, unsavedRow: boolean) => ({ info: at(revision, { ...base, sessionID: 's1' }, unsavedRow),
    parts: [{ id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text', text: 'tool call' }] });
  const pages: unknown[][] = [[row(5, false)], [row(6, true)], [row(4, false)]];
  const sdk = { session: { messages: async () => ({ data: pages.shift() ?? [], response: new Response(null, { headers: { 'x-smarty-ordinary-view': view } }) }) } };
  const children = new ChildStoreManager();
  const loader = new SessionMessageLoader(children, { sdk: sdk as never, runtimeKey: 'a' });
  const target = { directory: '/repo', sessionID: 's1' };
  const store = () => children.getChild('/repo')!;
  try {
    await loader.ensure(target);
    expect(isUnsaved(store().getState().message.s1[0])).toBe(false);
    // The tool result failed to append: the gateway republishes the row unsaved, with a higher revision.
    const draft = { ...store().getState(), message: { ...store().getState().message } };
    applyDirectoryEvent(draft as never, { type: 'message.updated', properties: { info: row(6, true).info } } as never);
    store().setState({ message: draft.message });
    expect(isUnsaved(store().getState().message.s1[0])).toBe(true);
    loader.invalidateOrdinaryViews();
    await loader.refreshOrdinaryView(target, true);
    expect(isUnsaved(store().getState().message.s1[0])).toBe(true);
    // A stale page from before (revision 4, saved) cannot clear it.
    loader.invalidateOrdinaryViews();
    await loader.refreshOrdinaryView(target, true);
    expect(isUnsaved(store().getState().message.s1[0])).toBe(true);
  } finally { loader.dispose(); children.disposeAll(); }
});
