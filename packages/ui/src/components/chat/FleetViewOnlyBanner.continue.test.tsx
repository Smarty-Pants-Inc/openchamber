import React, { act } from 'react';
import { afterAll, expect, mock, test } from 'bun:test';
import { sidebarHerdrI18n } from '@/lib/i18n/messages/sidebar-herdr.i18n';
import { NativeCreationError } from '@/lib/opencode/nativeCreation';
import { nativeComposerDom } from './composer/submit/__tests__/nativeComposer-dom';

// smarty-code#365: a Code-created session whose Pi ended offers "Continue in a new Pi": one click, one request; a
// refusal says why in the server's plain words, and nothing is retried.
const dom = nativeComposerDom();
afterAll(async () => { await dom.restore(); });
const toasts: string[] = [];
mock.module('@/components/ui', () => ({ toast: { error: (text: string) => { toasts.push(text); } } }));
// SAFETY: every key the banner asks for is a string entry of the English sidebar messages.
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => (sidebarHerdrI18n.en as Record<string, string>)[key] ?? key }) }));
const { FleetViewOnlyBanner } = await import('./FleetViewOnlyBanner');
const { createRoot } = await import('react-dom/client');
const deferred = () => { let reject: (error: Error) => void = () => {}; const promise = new Promise<void>((_, no) => { reject = no; }); return { promise, reject }; };

test('the ended view offers Continue in a new Pi; one click sends one request, and a refusal is shown, not retried', async () => {
  const root = createRoot(dom.container);
  const label = sidebarHerdrI18n.en['sessions.sidebar.herdr.continue'];
  const button = () => [...dom.container.querySelectorAll('button')].find(b => b.textContent === label);
  try {
    await act(async () => root.render(<FleetViewOnlyBanner ended />));
    expect(button()).toBeUndefined(); // Offered only where the gateway can continue it.
    let calls = 0, refuse = deferred();
    const onContinue = () => { calls++; return refuse.promise; };
    await act(async () => root.render(<FleetViewOnlyBanner ended onContinue={onContinue} />));
    await act(async () => { button()!.click(); });
    expect(button()!.disabled).toBe(true); // While it starts, a second click sends nothing.
    await act(async () => { button()!.click(); });
    expect(calls).toBe(1);
    await act(async () => { refuse.reject(new NativeCreationError('unknown', undefined, "This session's Pi is still running; open it in its tab")); });
    expect(toasts).toEqual(["This session's Pi is still running; open it in its tab"]);
    expect(button()!.disabled).toBe(false);
    expect(calls).toBe(1);
    refuse = deferred();
    await act(async () => { button()!.click(); });
    await act(async () => { refuse.reject(new Error('network')); });
    expect(toasts[1]).toBe(sidebarHerdrI18n.en['sessions.sidebar.herdr.continueFailed']);
  } finally { await act(async () => root.unmount()); }
});
