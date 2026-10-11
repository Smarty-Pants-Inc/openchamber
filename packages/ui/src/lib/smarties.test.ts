import { expect, test } from 'bun:test';
import { loadSmarties, loadSmartyFeed, sendSmartyMessage, SmartiesRequestError } from './smarties';

// smarty-code#1407, #1484: the client parses the gateway's /api/me/smarties answers once; only a missing route is
// "unavailable". A complete 200 may be empty; authorization refusals, partial answers and malformed bodies throw.
// Bodies are literal wire JSON (some deliberately malformed), so they go in as text.
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const calls: { url: string; init: RequestInit }[] = [];
const fake = (response: () => Response) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return response(); };

test('the list puts the own Smarty first', async () => {
  const result = await loadSmarties(fake(() => json('{"me":"kate","smarties":[{"id":"paul","label":"Paul’s Smarty","own":false,"writable":false},{"id":"kate","label":"Kate’s Smarty","own":true,"writable":true}]}')));
  expect(result.state === 'ready' && result.smarties.map(s => s.id)).toEqual(['kate', 'paul']);
  expect(calls.at(-1)?.url).toBe('/api/me/smarties');
});

test('404 is unavailable; a complete 200 empty list is empty, also with no person (smarty-code#1456); a 500 or a malformed body throws', async () => {
  expect(await loadSmarties(fake(() => new Response('Not Found', { status: 404 })))).toEqual({ state: 'unavailable' });
  expect(await loadSmarties(fake(() => json('{"me":"x","smarties":[]}')))).toEqual({ state: 'empty' });
  expect(await loadSmarties(fake(() => json('{"me":null,"smarties":[]}')))).toEqual({ state: 'empty' });
  await expect(loadSmarties(fake(() => json('{}', 500)))).rejects.toBeInstanceOf(SmartiesRequestError);
  await expect(loadSmarties(fake(() => json('{"me":"paul","smarties":[{"id":"paul"}]}')))).rejects.toThrow();
});

test('smarty-code#1484: a 403 authorization refusal throws instead of hiding Smarties as unavailable', async () => {
  const request = loadSmarties(fake(() => json('{"name":"APIError","data":{"message":"Not authorized to view Smarties."}}', 403)));
  await expect(request).rejects.toBeInstanceOf(SmartiesRequestError);
  expect(await request.catch(error => error)).toMatchObject({ status: 403 });
});

test('smarty-code#1484: only 200 is accepted, even when a 206 has a complete-shaped list', async () => {
  const request = loadSmarties(fake(() => json('{"me":"paul","smarties":[{"id":"paul","label":"Paul’s Smarty","own":true,"writable":true}]}', 206)));
  await expect(request).rejects.toBeInstanceOf(SmartiesRequestError);
  expect(await request.catch(error => error)).toMatchObject({ status: 206 });
});

test('smarty-code#1484: no person with a nonempty valid Smarty list is a malformed body, not empty', async () => {
  await expect(loadSmarties(fake(() => json('{"me":null,"smarties":[{"id":"paul","label":"Paul’s Smarty","own":true,"writable":true}]}')))).rejects.toThrow();
});

for (const [name, body] of [
  ['own true on another person', '{"me":"ann","smarties":[{"id":"kate","label":"Kate’s Smarty","own":true,"writable":true}]}'],
  ['own false on the signed-in person', '{"me":"ann","smarties":[{"id":"ann","label":"Ann’s Smarty","own":false,"writable":false}]}'],
  ['two own rows with the same self id', '{"me":"ann","smarties":[{"id":"ann","label":"Ann’s Smarty","own":true,"writable":true},{"id":"ann","label":"Ann’s other Smarty","own":true,"writable":true}]}'],
  ['own true but writable false', '{"me":"ann","smarties":[{"id":"ann","label":"Ann’s Smarty","own":true,"writable":false}]}'],
  ['own false but writable true', '{"me":"ann","smarties":[{"id":"kate","label":"Kate’s Smarty","own":false,"writable":true}]}'],
] as const) {
  test(`openchamber#611: the list rejects ${name}`, async () => {
    await expect(loadSmarties(fake(() => json(body)))).rejects.toThrow();
  });
}

test('openchamber#611: a person may have only a shared Smarty, with no own row', async () => {
  expect(await loadSmarties(fake(() => json('{"me":"ann","smarties":[{"id":"kate","label":"Kate’s Smarty","own":false,"writable":false}]}')))).toEqual({
    state: 'ready', me: 'ann', smarties: [{ id: 'kate', label: 'Kate’s Smarty', own: false, writable: false }],
  });
});

test('the feed reads the last blocks, or those after an offset; a send posts text and clientId', async () => {
  const feed = { blocks: [{ id: 'b1', author: 'org', at: '11:55 PM ET', text: 'Hi' }], offset: 10 };
  expect(await loadSmartyFeed('paul', {}, fake(() => json(JSON.stringify(feed))))).toEqual(feed);
  expect(calls.at(-1)?.url).toBe('/api/me/smarties/paul/feed');
  await loadSmartyFeed('paul', { after: 10 }, fake(() => json(JSON.stringify(feed))));
  expect(calls.at(-1)?.url).toBe('/api/me/smarties/paul/feed?after=10');
  // The gateway's paging cursor is `earlier` (null at the top).
  expect(await loadSmartyFeed('paul', { before: 500, limit: 100 }, fake(() => json(JSON.stringify({ ...feed, earlier: null }))))).toEqual({ ...feed, earlier: null });
  expect(calls.at(-1)?.url).toBe('/api/me/smarties/paul/feed?before=500&limit=100');
  expect(loadSmartyFeed('kate', {}, fake(() => json(JSON.stringify({}), 403)))).rejects.toBeInstanceOf(SmartiesRequestError);
  await sendSmartyMessage('paul', 'Ship it', 'msg_1', fake(() => json(JSON.stringify({ accepted: true }), 202)));
  expect(calls.at(-1)).toMatchObject({ url: '/api/me/smarties/paul/messages', init: { method: 'POST', body: JSON.stringify({ text: 'Ship it', clientId: 'msg_1' }) } });
  expect(sendSmartyMessage('kate', 'x', 'msg_2', fake(() => json(JSON.stringify({}), 502)))).rejects.toBeInstanceOf(SmartiesRequestError);
});

test('a refused send carries the gateway’s plain message: JSON error or message, or plain text; never an HTML page', async () => {
  const refusal = async (response: Response) => {
    try { await sendSmartyMessage('paul', 'x', 'msg_3', fake(() => response)); } catch (error) { return error; }
    throw new Error('expected a refusal');
  };
  const tooLong = 'Message is too long (max 120 KB).';
  const fromError = await refusal(json(JSON.stringify({ error: tooLong }), 413));
  expect(fromError).toBeInstanceOf(SmartiesRequestError);
  expect(fromError).toMatchObject({ status: 413, serverMessage: tooLong });
  expect(await refusal(json(JSON.stringify({ message: tooLong }), 413))).toMatchObject({ serverMessage: tooLong });
  // The gateway's real shape (errorResponse): {name, data: {message}}.
  expect(await refusal(json(JSON.stringify({ name: 'APIError', data: { message: tooLong, isRetryable: false } }), 413))).toMatchObject({ serverMessage: tooLong });
  expect(await refusal(new Response(`${tooLong}\n`, { status: 413, headers: { 'content-type': 'text/plain' } }))).toMatchObject({ serverMessage: tooLong });
  expect(await refusal(new Response('<html><body>Bad gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }))).toMatchObject({ status: 502, serverMessage: undefined });
  expect(await refusal(json(JSON.stringify({}), 500))).toMatchObject({ serverMessage: undefined });
});

test('a huge or never-ending refusal body is read only up to 4 KB, then cancelled (#567 security)', async () => {
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(new TextEncoder().encode('x'.repeat(1024))); },
    cancel() { cancelled = true; },
  });
  const error = await sendSmartyMessage('paul', 'x', 'msg_4', fake(() => new Response(endless, { status: 413, headers: { 'content-type': 'text/plain' } }))).catch(e => e);
  expect(error).toBeInstanceOf(SmartiesRequestError);
  expect(error).toMatchObject({ status: 413, serverMessage: undefined }); // over 500 characters: no message shown
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(10);
});

test('a refusal body that stalls gives up after the timeout, and one oversized chunk is cut to the limit (#567 r4)', async () => {
  let cancelled = false;
  const stalls = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('Message is too long')); },
    pull() { return new Promise<void>(() => undefined); }, // never yields again
    cancel() { cancelled = true; },
  });
  const started = Date.now();
  const error = await sendSmartyMessage('paul', 'x', 'msg_5', fake(() => new Response(stalls, { status: 413, headers: { 'content-type': 'text/plain' } }))).catch(e => e);
  expect(error).toMatchObject({ status: 413, serverMessage: undefined });
  expect(Date.now() - started).toBeLessThan(6000);
  expect(cancelled).toBe(true);
  const huge = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('y'.repeat(1_000_000))); c.close(); } }), { status: 413, headers: { 'content-type': 'text/plain' } });
  expect(await sendSmartyMessage('paul', 'x', 'msg_6', fake(() => huge)).catch(e => e)).toMatchObject({ status: 413, serverMessage: undefined });
}, 15_000);

test('smarty-code#1525: a thinking block keeps kind "thinking"; an ordinary block has no kind; an unknown kind is malformed', async () => {
  const feed = { blocks: [{ id: 't1', author: 'org', at: '9:00 AM ET', text: 'Weighing it.', kind: 'thinking' }, { id: 'r1', author: 'org', at: '9:00 AM ET', text: 'Done.' }], offset: 20 };
  const parsed = await loadSmartyFeed('alex', {}, fake(() => json(JSON.stringify(feed))));
  expect(parsed).toEqual(feed);
  expect('kind' in parsed.blocks[1]!).toBe(false);
  await expect(loadSmartyFeed('alex', {}, fake(() => json('{"blocks":[{"id":"x","author":"org","at":"","text":"","kind":"tool"}],"offset":1}')))).rejects.toThrow();
});
