// openchamber#394 review 2 (2): the HEALTHY path on a candidate (the #916 gateway on main + this PR's page), recorded
// headed: the page polls /api/session/status?unknown=1, every project answers, statuses update normally (busy -> idle on a
// real turn in each of two projects), and "Status unavailable" shows nowhere. Fixture sign-in (NOT Google), its cookie
// added before the recording starts (a separate context, then storageState). Candidate stack only (its own roots).
// Usage: xvfb-run -a -s "-screen 0 1600x1000x24" node --experimental-strip-types healthy.ts <root> <out> <port>
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadavg } from 'node:os';
import { join } from 'node:path';

const [root, out, port] = process.argv.slice(2) as [string, string, string];
const origin = `http://127.0.0.1:${port}`;
process.env.SMARTY_CODE_STAGING_ORIGIN = origin;
mkdirSync(out, { recursive: true });
const release = join(root, 'release');
const { chromium, expect } = createRequire(join(release, 'package.json'))('@playwright/test');
const ui = await import(join(release, 'integration/deployed/real-path/ui.ts'));
const steps = join(out, 'steps.jsonl'); writeFileSync(steps, '');
const log = (entry: object) => appendFileSync(steps, JSON.stringify({ at: new Date().toISOString(), load1: loadavg()[0].toFixed(0), ...entry }) + '\n');
const browser = await chromium.launch({ headless: false });
const setup = await browser.newContext();
await setup.addCookies(JSON.parse(readFileSync(join(root, 'cookies.json'), 'utf8'))); // Before the recording.
const state = await setup.storageState(); await setup.close();
const rec = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state, recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
const page = await rec.newPage();
const polls: { at: string; status: number; unknownAsked: boolean; unknown: unknown; ids: number }[] = [];
page.on('response', async (r: any) => {
  const u = new URL(r.url()); if (u.pathname !== '/api/session/status' || u.searchParams.get('directory')) return;
  const body = await r.json().catch(() => null);
  polls.push({ at: new Date().toISOString(), status: r.status(), unknownAsked: u.searchParams.get('unknown') === '1', unknown: body?.['smarty.unknown'] ?? null, ids: body ? Object.keys(body).length : 0 });
});
let n = 0, failed = false;
const step = async (action: string, expected: string, act: () => Promise<unknown>) => {
  const began = Date.now();
  try { const observed = await act(); log({ n: ++n, action, expected, ok: true, ms: Date.now() - began, observed }); }
  catch (error) { failed = true; log({ n: ++n, action, expected, ok: false, ms: Date.now() - began, error: String((error as Error).message).split('\n')[0] }); throw error; }
  finally { await page.screenshot({ path: join(out, `step-${String(n).padStart(2, '0')}.png`) }).catch(() => {}); }
};
const stop = () => page.getByRole('button', { name: 'Stop generating', exact: true });
const unavailable = () => page.getByText('Status unavailable', { exact: true });
const ids: Record<string, string> = {};
try {
  await step('Opens Code (fixture sign-in)', 'The fleet list shows both projects', async () => {
    await page.goto(origin + '/'); await page.locator('[data-session-row]').first().waitFor({ timeout: 90_000 });
    return { rows: await page.locator('[data-session-row]').count() };
  });
  for (const [project, name, tag] of [['A', 'Code candidate #394 (healthy path)', 'a394'], ['B', 'Code candidate #394 (healthy path), session 1', 'b394']] as const) {
    await step(`New session in project ${project}; sends a 25-second tool run`, 'It works (Stop shows), and "Status unavailable" shows nowhere', async () => {
      const r = await ui.startOwnSession(page, `Run exactly this one bash command and nothing else: sleep 25; echo ${tag}. Then answer with one word: done.`, undefined, name);
      ids[project] = String(r.session); if (ui.selected(page) !== ids[project]) await ui.openRow(page, ids[project]!);
      await expect(stop()).toBeVisible({ timeout: 60_000 }); await expect(unavailable()).toHaveCount(0);
      return { session: ids[project] };
    });
  }
  await step('Opens project A\'s session and waits for its turn to end', 'Busy -> idle: Stop goes away and the reply "done" shows; no "Status unavailable"', async () => {
    await ui.openRow(page, ids.A!); await expect(stop()).toBeHidden({ timeout: 120_000 });
    await expect(page.getByText(/^done\.?$/i).last()).toBeVisible({ timeout: 30_000 }); await expect(unavailable()).toHaveCount(0);
    return {};
  });
  await step('Waits 10 s on project A after its turn', 'No working-status row ("is running command") remains', async () => {
    await page.waitForTimeout(10_000); const row = await page.getByText(/is running command|is working|is thinking/i).count();
    if (row) throw new Error(`a working-status row remains (${row})`); return {};
  });
  await step('Opens project B\'s session', 'Its turn also ended (busy -> idle) and it reads idle; no "Status unavailable" in the page or the sidebar', async () => {
    await ui.openRow(page, ids.B!); await expect(stop()).toBeHidden({ timeout: 120_000 }); await expect(unavailable()).toHaveCount(0);
    return {};
  });
} catch { /* recorded in steps.jsonl */ }
finally {
  const asked = polls.filter(p => p.unknownAsked);
  const summary = { steps: n, failed, fleetPolls: polls.length, askedUnknown: asked.length, statuses: [...new Set(polls.map(p => p.status))],
    withUnknownMarker: polls.filter(p => p.unknown).length, sessions: ids };
  writeFileSync(join(out, 'polls.json'), JSON.stringify(polls, null, 1)); writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  log({ event: 'done', summary });
  const video = page.video(); await page.close(); await rec.close(); await browser.close();
  console.log(JSON.stringify({ ...summary, video: await video?.path() }));
}
