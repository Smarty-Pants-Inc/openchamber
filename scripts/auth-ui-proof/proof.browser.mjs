import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4179';
const user = { id: 'fixture-user', name: 'Current Alice', email: 'alice@example.test', emailVerified: true,
  image: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const session = { user, session: { id: 'fixture-session', userId: user.id, token: 'synthetic-only',
  expiresAt: '2099-01-01T00:00:00Z', createdAt: user.createdAt, updatedAt: user.updatedAt } };
const failure = { status: 500, json: { code: 'FIXTURE_ERROR', message: 'Synthetic error' } };

async function setup(page) {
  const requests = [], unexpected = [];
  const handlers = new Map();
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { unexpected.push(req.url()); return route.abort(); }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      requests.push({ path: url.pathname, method: req.method(), body: req.postDataJSON() });
      const handler = handlers.get(url.pathname);
      if (handler) return handler(route);
      if (url.pathname === '/api/auth/get-session') return route.fulfill({ json: session });
      unexpected.push(req.url());
      return route.fulfill({ status: 503, json: { message: 'Unconfigured fixture request' } });
    }
    return route.continue();
  });
  return { requests, unexpected, handlers };
}
async function shot(page, info, name) {
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}
async function open(page) {
  const account = page.getByRole('button', { name: 'Account', exact: true });
  await account.focus(); await account.press('Enter');
}
function hold(handlers, path, response) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  handlers.set(path, async route => { await gate; await route.fulfill(response); });
  return release;
}

test('Google button sends official request, remains busy, and shows HTTP error', async ({ page }, info) => {
  const api = await setup(page);
  const release = hold(api.handlers, '/api/auth/sign-in/social', failure);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Sign in with Google', exact: true });
  await button.click();
  await expect(button).toBeDisabled();
  await expect.poll(() => api.requests.find(r => r.path.endsWith('/sign-in/social'))?.body)
    .toMatchObject({ provider: 'google', disableRedirect: true, callbackURL: `${origin}/` });
  await shot(page, info, 'google-busy'); release();
  await expect(page.getByRole('alert')).toContainText('Account action failed');
  await expect(button).toBeEnabled();
  await shot(page, info, 'google-error');
  expect(api.unexpected).toEqual([]);
});

test('loading, profile save error/success, historical versus unnamed authors', async ({ page }, info) => {
  const api = await setup(page);
  const release = hold(api.handlers, '/api/auth/get-session', { json: session });
  await page.goto('/'); await open(page);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
  expect(await page.getByRole('dialog').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })).toBe(true);
  await shot(page, info, 'account-loading'); release();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toHaveValue('Current Alice');
  await name.fill('Edited Alice');
  await page.getByRole('textbox', { name: 'Photo URL' }).fill('https://images.example.test/avatar.png');
  api.handlers.set('/api/auth/update-user', route => route.fulfill(failure));
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible(); await shot(page, info, 'save-error');
  // Avoid external image loading; empty avatar is itself a supported profile update.
  await page.getByRole('textbox', { name: 'Photo URL' }).fill('');
  api.handlers.set('/api/auth/update-user', route => route.fulfill({ json: { status: true } }));
  await name.focus(); await name.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toContainText('Edited Alice');
  expect(api.requests.filter(r => r.path.endsWith('/update-user')).map(r => r.body)).toEqual([
    { name: 'Edited Alice', image: 'https://images.example.test/avatar.png' }, { name: 'Edited Alice', image: '' },
  ]);
  await expect(page.getByTestId('historical')).toHaveText('Historical Alice');
  await expect(page.getByTestId('unnamed')).toBeEmpty(); await expect(page.getByTestId('forged')).toBeEmpty();
  await shot(page, info, 'saved-and-authors'); expect(api.unexpected).toEqual([]);
});

test('session load error is visible and does not enable profile writes', async ({ page }, info) => {
  const api = await setup(page);
  api.handlers.set('/api/auth/get-session', route => route.fulfill(failure));
  await page.goto('/'); await open(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeDisabled();
  await shot(page, info, 'load-error'); expect(api.unexpected).toEqual([]);
});

for (const action of [
  { label: 'Sign out', path: 'sign-out', state: 'reauthenticating' },
  { label: 'Sign out other devices', path: 'revoke-other-sessions', state: 'ok' },
]) test(`${action.path} failure then success`, async ({ page }, info) => {
  const api = await setup(page);
  await page.goto('/'); await open(page);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Current Alice');
  api.handlers.set(`/api/auth/${action.path}`, route => route.fulfill(failure));
  const button = page.getByRole('button', { name: action.label, exact: true });
  await button.click(); await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('auth-state')).toHaveText('ok');
  await shot(page, info, `${action.path}-error`);
  api.handlers.set(`/api/auth/${action.path}`, route => route.fulfill({ json: { success: true } }));
  await button.click(); await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('auth-state')).toHaveText(action.state);
  expect(api.requests.filter(r => r.path.endsWith(`/${action.path}`)).map(r => r.method)).toEqual(['POST', 'POST']);
  await shot(page, info, `${action.path}-success`); expect(api.unexpected).toEqual([]);
});

for (const path of ['get-session', 'update-user', 'sign-out', 'revoke-other-sessions', 'sign-in/social']) {
  test(`stale runtime completion: ${path}`, async ({ page }, info) => {
    const api = await setup(page);
    const response = path === 'get-session' ? { json: session }
      : path === 'sign-in/social' ? { json: { url: 'https://accounts.google.com/synthetic', redirect: true } }
      : { json: { success: true } };
    const release = hold(api.handlers, `/api/auth/${path}`, response);
    await page.goto('/');
    if (path === 'sign-in/social') await page.getByRole('button', { name: 'Sign in with Google' }).click();
    else {
      await open(page);
      if (path !== 'get-session') {
        await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Current Alice');
        if (path === 'update-user') await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Stale Alice');
        const label = { 'update-user': 'Save profile', 'sign-out': 'Sign out', 'revoke-other-sessions': 'Sign out other devices' }[path];
        await page.getByRole('button', { name: label, exact: true }).click();
      }
    }
    await expect.poll(() => api.requests.some(r => r.path === `/api/auth/${path}`)).toBe(true);
    // Dialog is modal: invoke the real fixture control without bypassing its handler.
    await page.getByRole('button', { name: 'Fixture: change runtime', includeHidden: true }).evaluate(el => el.click());
    const completed = page.waitForResponse(r => new URL(r.url()).pathname === `/api/auth/${path}`);
    release(); await completed;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByTestId('auth-state')).toHaveText('ok');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Account', exact: true, includeHidden: true })).not.toContainText('Stale Alice');
    if (path === 'get-session') await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
    if (path === 'update-user') await expect(page.getByRole('dialog')).toBeVisible();
    expect(page.url()).toBe(`${origin}/`);
    await shot(page, info, `stale-${path.replaceAll('/', '-')}`); expect(api.unexpected).toEqual([]);
  });
}
