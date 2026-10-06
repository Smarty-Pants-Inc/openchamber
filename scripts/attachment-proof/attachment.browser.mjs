import { test, expect } from '@playwright/test';

const session = { id: 'proof-session', slug: 'proof', title: 'Attachment proof', projectID: 'proof', directory: '/attachment-proof', version: '1', time: { created: 1, updated: 1 } };
const model = { id: 'text', name: 'Fixture text model', providerID: 'proof', api: { id: 'text', url: '', npm: '' }, cost: { input: 0, output: 0 }, limit: { context: 100000, output: 1000 }, capabilities: { temperature: true, reasoning: false, attachment: true, toolcall: true, input: { text: true, image: true, pdf: true }, output: { text: true } }, release_date: '2026-01-01', status: 'active', options: {}, headers: {}, variants: {} };

async function setup(page) {
  const prompts = [], errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4180') return route.abort();
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) return route.continue();
    requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname.endsWith('/prompt_async')) { prompts.push(request.postDataJSON()); return route.fulfill({ status: 204 }); }
    if (url.pathname.endsWith('/global/health')) return route.fulfill({ json: { healthy: true } });
    if (url.pathname.endsWith('/config/providers')) return route.fulfill({ json: { providers: [{ id: 'proof', name: 'Fixture', env: [], models: { text: model } }], default: { proof: 'text' } } });
    if (url.pathname.endsWith('/provider')) return route.fulfill({ json: { all: [], default: {}, connected: ['proof'] } });
    if (url.pathname.endsWith('/config/settings')) return route.fulfill({ json: { settings: { defaultModel: 'proof/text' } } });
    if (url.pathname.endsWith('/agent')) return route.fulfill({ json: [{ name: 'build', description: 'Fixture', mode: 'primary', options: {}, permission: [] }] });
    if (url.pathname.endsWith('/message') || url.pathname.endsWith('/permission') || url.pathname.endsWith('/question') || url.pathname.endsWith('/command') || url.pathname.endsWith('/todo')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/session/status')) return route.fulfill({ json: { 'proof-session': { type: 'idle' } } });
    if (url.pathname.endsWith('/session')) return route.fulfill({ json: [session] });
    if (url.pathname.endsWith('/session/proof-session')) return route.fulfill({ json: session });
    if (url.pathname.endsWith('/event') || url.pathname.endsWith('/global/event')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (url.pathname.endsWith('/git/status')) return route.fulfill({ json: { isGitRepo: false, files: [] } });
    if (url.pathname.endsWith('/path')) return route.fulfill({ json: { directory: '/attachment-proof', worktree: '/attachment-proof', home: '/fixture', state: '/fixture', config: '/fixture' } });
    if (url.pathname.endsWith('/project')) return route.fulfill({ json: [{ id: 'proof', worktree: '/attachment-proof', time: { created: 1 } }] });
    if (url.pathname.endsWith('/project/current')) return route.fulfill({ json: { id: 'proof', worktree: '/attachment-proof', time: { created: 1 } } });
    if (url.pathname.includes('session-knowledge')) return route.fulfill({ status: 404 });
    return route.fulfill({ json: {} });
  });
  return { prompts, errors, requests };
}

async function chooser(page, info) {
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click();
  if (info) await info.attach('attach-menu', { body: await page.screenshot(), contentType: 'image/png' });
  const pending = page.waitForEvent('filechooser', { timeout: 3000 });
  await page.getByRole('menuitem', { name: 'Attach files', exact: true }).click();
  return pending;
}

async function filesEvent(page, kind, mixed = false) {
  await page.locator('.cm-content').evaluate((editor, { kind, mixed }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([80,75,5,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0])], 'archive.zip', { type: 'application/zip' }));
    if (mixed) transfer.items.add(new File(['hello attachment'], 'notes.txt', { type: 'text/plain' }));
    editor.dispatchEvent(kind === 'paste'
      ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { kind, mixed });
}

test('real attach menu emits a filechooser event', async ({ page }, info) => {
  const api = await setup(page);
  await page.goto('/');
  const picker = await chooser(page, info);
  await info.attach('chooser-event', { body: JSON.stringify({ filechooser: true, multiple: picker.isMultiple(), accept: await picker.element().getAttribute('accept') }, null, 2), contentType: 'application/json' });
  expect(picker.isMultiple()).toBe(true);
  expect(await picker.element().getAttribute('accept')).not.toContain('.zip');
  await picker.setFiles([]);
  expect(api.errors).toEqual([]);
});

test('attach menu explains supported types and the ZIP filter', async ({ page }, info) => {
  await setup(page); await page.goto('/');
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click();
  await expect(page.getByRole('menu')).toContainText('Supported: images, PDF, Office documents, text, and code files. ZIP files are not supported yet.');
  await info.attach('supported-type-menu', { body: await page.screenshot(), contentType: 'image/png' });
});

test('selected allowed text file becomes an actual attachment chip and is sent', async ({ page }, info) => {
  const api = await setup(page); await page.goto('/');
  const picker = await chooser(page, info);
  await picker.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello attachment') });
  await expect(page.getByRole('button', { name: /^notes\.txt/ })).toBeVisible();
  await info.attach('text-attachment-chip', { body: await page.screenshot(), contentType: 'image/png' });
  await page.locator('.cm-content').fill('Please read the attached text.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => api.prompts.length).toBe(1);
  expect(api.prompts[0].parts).toContainEqual(expect.objectContaining({ type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'data:text/plain;base64,aGVsbG8gYXR0YWNobWVudA==' }));
  await info.attach('synthetic-send', { body: JSON.stringify(api.prompts[0], null, 2), contentType: 'application/json' });
  await expect(page.getByRole('button', { name: /^notes\.txt/ })).toHaveCount(0);
  await info.attach('after-send', { body: await page.screenshot(), contentType: 'image/png' });
  expect(api.errors).toEqual([]);
});

for (const kind of ['drop', 'paste']) for (const mixed of [false, true]) test(`${kind} ZIP ${mixed ? 'mixed batch' : 'alone'} explains rejection and preserves allowed files`, async ({ page }, info) => {
  const api = await setup(page); await page.goto('/');
  await expect(page.locator('.cm-content')).toBeVisible();
  await filesEvent(page, kind, mixed);
  await expect(page.getByText("ZIP files can't be attached yet. Supported: images, PDF, Office documents, text, and code files.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^archive\.zip/ })).toHaveCount(0);
  if (mixed) await expect(page.getByRole('button', { name: /^notes\.txt/ })).toBeVisible();
  else await expect(page.locator('button[aria-label^="Remove "]')).toHaveCount(0);
  await info.attach(`${kind}-zip-feedback`, { body: await page.screenshot(), contentType: 'image/png' });
  expect(api.errors).toEqual([]);
});

test('mobile attachment sheet explains types and opens the chooser', async ({ page }, info) => {
  const api = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?mobile');
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('ZIP files are not supported yet.');
  await info.attach('mobile-supported-types', { body: await page.screenshot(), contentType: 'image/png' });
  const pending = page.waitForEvent('filechooser', { timeout: 3000 });
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await pending).setFiles({ name: 'mobile-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello attachment') });
  await expect(page.getByRole('button', { name: /^mobile-notes\.txt/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await info.attach('mobile-text-chip', { body: await page.screenshot(), contentType: 'image/png' });
  expect(api.errors).toEqual([]);
});

test('overriding the picker filter still rejects a selected binary ZIP', async ({ page }) => {
  const api = await setup(page); await page.goto('/');
  const picker = await chooser(page);
  await picker.setFiles({ name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from([80,75,5,6,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]) });
  await expect(page.getByText("ZIP files can't be attached yet. Supported: images, PDF, Office documents, text, and code files.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^archive\.zip/ })).toHaveCount(0);
  expect(api.errors).toEqual([]);
});

test('an unsupported non-ZIP binary drop is explained and attaches nothing', async ({ page }) => {
  const api = await setup(page); await page.goto('/');
  await page.locator('.cm-content').evaluate(editor => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([0,1,0,2])], 'binary.bin', { type: 'application/octet-stream' }));
    editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByText("Can't attach binary.bin. Supported: images, PDF, Office documents, text, and code files.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^binary\.bin/ })).toHaveCount(0);
  expect(api.errors).toEqual([]);
});
