import React, { act } from 'react';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFile } from 'node:fs/promises';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Provider, Session } from '@opencode-ai/sdk/v2';

// smarty-code#1580: a fresh iPhone-sized browser showed "GPT-6.1 Sol" (its saved/default choice) in the mobile
// composer of an ordinary session that runs Claude Opus 5.5. The mobile pill read the browser's model store.
const win = new Window({ url: 'https://code.example.test' });
Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator,
  HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win), ResizeObserver: win.ResizeObserver,
  CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
// Vite-only `import.meta.glob` (provider logos): no logos under Bun.
await plugin({ name: 'composer-model-vite-transforms', setup(build) {
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, async ({ path }) => ({ loader: 'ts',
    contents: (await readFile(path, 'utf8')).replace(/import\.meta\.glob<string>\([\s\S]*?\);/, '{};') }));
} });
const sync = await import('@/sync/sync-context');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { I18nProvider } = await import('@/lib/i18n');
const { MobileModelButton } = await import('./MobileModelButton');
const { ModelControls } = await import('./ModelControls');
afterAll(async () => { await win.happyDOM.close(); });

const model = (providerID: string, id: string, name: string): Provider['models'][string] => ({
  id, providerID, name, family: 'fixture', api: { id, url: '', npm: '' },
  capabilities: { temperature: false, reasoning: false, attachment: false, toolcall: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 100 }, status: 'active', options: {}, headers: {}, release_date: '',
});
const opus = { providerID: 'cliproxyapi-anthropic', modelID: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
const sol = model('cliproxyapi', 'gpt-6-1-sol', 'GPT-6.1 Sol');
const catalog: Provider[] = [
  { id: 'cliproxyapi', name: 'CLIProxy', source: 'custom', env: [], options: {}, models: { [sol.id]: sol } },
  { id: opus.providerID, name: 'Anthropic', source: 'custom', env: [], options: {},
    models: { [opus.modelID]: model(opus.providerID, opus.modelID, opus.name) } },
];
const session: Session = {
  id: 'ses_ordinary', slug: 'ordinary', projectID: 'p', directory: '/repo', title: 'Ordinary', version: '1',
  time: { created: 1, updated: 1 },
};
const ordinarySession = { ...session, nativeRuntime: 'ordinary',
  ordinary: { generation: 'g1', sequence: 1, model: opus, thinkingLevel: 'medium' } };

test('an ordinary session never shows the browser model, on mobile and desktop, also before it loads', async () => {
  // This browser's own choice (a saved preference or the first provider's default) is GPT-6.1 Sol.
  useConfigStore.setState({ currentProviderId: 'cliproxyapi', currentModelId: sol.id,
    providers: catalog.map(entry => ({ ...entry, models: Object.values(entry.models) })) });
  useSessionUIStore.setState({ currentSessionId: session.id });
  let shownSession: Session | undefined;
  const useSession = spyOn(sync, 'useSession').mockImplementation(() => shownSession);
  const answers: Array<(value: { providers: Provider[]; default: Record<string, string> }) => void> = [];
  const providers = spyOn(opencodeClient, 'getProvidersForConfig')
    .mockImplementation(() => new Promise(resolve => { answers.push(resolve); }));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const seen: string[] = [];
  const Probe = () => { React.useLayoutEffect(() => { seen.push(host.textContent ?? ''); }); return null; };
  const render = () => act(async () => {
    root.render(<I18nProvider>
      <div data-layout="mobile"><MobileModelButton onOpenModel={() => {}} />
        <ModelControls className="hidden" mobilePanel={null} onMobilePanelChange={() => {}} /></div>
      <div data-layout="desktop"><ModelControls /></div>
      <Probe />
    </I18nProvider>);
  });
  const layout = (name: string) => host.querySelector(`[data-layout="${name}"]`)?.textContent ?? '';

  await render(); // first load: the session record has not arrived
  expect(layout('mobile')).toBe('Loading...');
  expect(layout('desktop')).toBe('Loading...');
  shownSession = ordinarySession;
  await render(); // the ordinary state arrived; its catalog is still loading
  expect(layout('mobile')).toBe('Loading...');
  expect(answers.length).toBe(2); // the visible pill and the desktop slot; the hidden mobile sheet host reads none
  await act(async () => { for (const answer of answers) answer({ providers: catalog, default: {} }); });
  expect(layout('mobile')).toContain('Claude Opus 5.5');
  expect(layout('desktop')).toContain('Claude Opus 5.5');
  expect(seen.some(text => text.includes('GPT-6.1 Sol'))).toBe(false);

  // Counterexample: an OpenCode session (no native runtime) still shows this browser's choice.
  // (Only the pill: the configured desktop picker needs the full sync runtime.)
  shownSession = session;
  await act(async () => { root.render(<I18nProvider><MobileModelButton onOpenModel={() => {}} /></I18nProvider>); });
  expect(host.textContent).toContain('GPT-6.1 Sol');
  await act(async () => root.unmount());
  host.remove();
  useSession.mockRestore();
  providers.mockRestore();
});
