import { expect, test } from 'bun:test';
import { loadSmarties, loadSmartyFeed, sendSmartyMessage, SmartiesRequestError } from './smarties';

// smarty-code#1407: the client parses the gateway's /api/me/smarties answers once; a missing route or a person without a
// Smarty is "unavailable", any other failure throws (never an empty list).
// Bodies are literal wire JSON (some deliberately malformed), so they go in as text.
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const calls: { url: string; init: RequestInit }[] = [];
const fake = (response: () => Response) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return response(); };

test('the list puts the own Smarty first', async () => {
  const result = await loadSmarties(fake(() => json(JSON.stringify({ me: 'kate', smarties: [
    { id: 'paul', label: 'Paul’s Smarty', own: false, writable: false }, { id: 'kate', label: 'Kate’s Smarty', own: true, writable: true }] }))));
  expect(result.state === 'ready' && result.smarties.map(s => s.id)).toEqual(['kate', 'paul']);
  expect(calls.at(-1)?.url).toBe('/api/me/smarties');
});

test('404, 403 and an empty list are unavailable; a 500 or a malformed body throws', async () => {
  expect(await loadSmarties(fake(() => new Response('Not Found', { status: 404 })))).toEqual({ state: 'unavailable' });
  expect(await loadSmarties(fake(() => json(JSON.stringify({}), 403)))).toEqual({ state: 'unavailable' });
  expect(await loadSmarties(fake(() => json(JSON.stringify({ me: 'x', smarties: [] }))))).toEqual({ state: 'unavailable' });
  expect(loadSmarties(fake(() => json(JSON.stringify({}), 500)))).rejects.toBeInstanceOf(SmartiesRequestError);
  expect(loadSmarties(fake(() => json(JSON.stringify({ me: 'paul', smarties: [{ id: 'paul' }] }))))).rejects.toThrow();
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
