import React, { act } from 'react';
import { afterAll, expect, mock, test } from 'bun:test';
import { sidebarHerdrI18n } from '@/lib/i18n/messages/sidebar-herdr.i18n';
import type { ContinueStatus } from '@/sync/native-session-resume';
import { nativeComposerDom } from './composer/submit/__tests__/nativeComposer-dom';

// smarty-code#365: the ended view says what Continue does, shows a start in progress, and after a reply that was lost
// shows the unknown outcome with Check again, never Continue again and never "nothing started".
const dom = nativeComposerDom();
afterAll(async () => { await dom.restore(); });
let status: ContinueStatus | undefined;
const calls: string[] = [];
mock.module('@/sync/native-session-resume', () => ({ useContinueStatus: () => status,
  continueEndedSession: async () => { calls.push('continue'); }, checkContinue: async () => { calls.push('check'); } }));
mock.module('@/components/ui', () => ({ toast: { error: () => {} } }));
// SAFETY: every key the banner asks for is a string entry of the English sidebar messages.
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, vars?: Record<string, string>) =>
  ((sidebarHerdrI18n.en as Record<string, string>)[key] ?? key).replace('{project}', vars?.project ?? '') }) }));
const { FleetViewOnlyBanner } = await import('./FleetViewOnlyBanner');
const { createRoot } = await import('react-dom/client');
const en = sidebarHerdrI18n.en;

test('each Continue state says what is true, and offers only safe actions', async () => {
  const root = createRoot(dom.container);
  const resume = { directory: '/p/smarty-code', sessionID: 'ses_ended', project: 'smarty-code' };
  const buttons = () => [...dom.container.querySelectorAll('button')].map(b => b.textContent);
  const text = () => dom.container.textContent ?? '';
  const show = async (value: ContinueStatus | undefined) => { status = value; await act(async () => root.render(<FleetViewOnlyBanner ended resume={resume} />)); };
  try {
    await show(undefined);
    expect(text()).toContain('Starts a new Pi in smarty-code on this session.');
    expect(buttons()).toEqual([en['sessions.sidebar.herdr.continue']]);
    await act(async () => { dom.container.querySelector('button')?.click(); });
    expect(calls).toEqual(['continue']);
    await show({ status: 'starting', requestId: 'r' });
    expect(text()).toContain('A new Pi is starting in smarty-code on this session.');
    expect(buttons()).toEqual([]); // Nothing to click while it starts.
    await show({ status: 'unknown', requestId: 'r' });
    expect(text()).toContain(en['sessions.sidebar.herdr.continueUnknown']);
    expect(text()).not.toContain('Nothing was started');
    expect(buttons()).toEqual([en['sessions.sidebar.herdr.continueCheck']]); // Reads only; no second start.
    await show({ status: 'unknown', requestId: 'r', checked: true });
    expect(buttons()).toEqual([en['sessions.sidebar.herdr.continueCheck'], en['sessions.sidebar.herdr.continue']]);
    await show({ status: 'stopped' });
    expect(text()).toContain(en['sessions.sidebar.herdr.continueStopped']);
  } finally { await act(async () => root.unmount()); }
});
