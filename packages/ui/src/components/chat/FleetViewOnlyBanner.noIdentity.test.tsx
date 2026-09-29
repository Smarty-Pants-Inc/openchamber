import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { sidebarHerdrI18n } from '@/lib/i18n/messages/sidebar-herdr.i18n';

// SAFETY: every key the banner asks for is a string entry of the English sidebar messages.
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => (sidebarHerdrI18n.en as Record<string, string>)[key] ?? key }) }));
const { FleetViewOnlyBanner } = await import('./FleetViewOnlyBanner');

test('a Pi without a session identity reads as starting, not an enrollment link (smarty-code#126 (c)3, #863)', () => {
  const html = renderToStaticMarkup(<FleetViewOnlyBanner noIdentity />);
  expect(html).toContain('Starting: this Pi has not reported its session yet. It opens here when it does.');
  // smarty-code#126 F7 (c): plain words, no internal tool names.
  expect(html).not.toContain('Herdr');
  expect(html).not.toContain('href=');
  expect(html).not.toContain('No sessions');
});

test('a Code-created session whose Pi ended says so plainly, with no enrollment link', () => {
  const html = renderToStaticMarkup(<FleetViewOnlyBanner ended />);
  expect(html).toContain('This session’s Pi has ended. You can read it here, but you cannot send to it.');
  expect(html).not.toContain('href=');
});

test('a fleet Pi mid-reload says it is back in a moment, not View only, with no enrollment link (smarty-code#870)', () => {
  const html = renderToStaticMarkup(<FleetViewOnlyBanner reloading />);
  expect(html).toContain('This session’s Pi is reloading. You can send to it again when it is back, in a moment.');
  expect(html).not.toContain('href=');
});
