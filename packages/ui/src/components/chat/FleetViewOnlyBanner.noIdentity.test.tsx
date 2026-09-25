import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { sidebarHerdrI18n } from '@/lib/i18n/messages/sidebar-herdr.i18n';

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => (sidebarHerdrI18n.en as Record<string, string>)[key] ?? key }) }));
const { FleetViewOnlyBanner } = await import('./FleetViewOnlyBanner');

test('a Pi without a session identity opens with its plain reason, not an enrollment link (smarty-code#126 (c)3)', () => {
  const html = renderToStaticMarkup(<FleetViewOnlyBanner noIdentity />);
  expect(html).toContain('Code cannot show this session’s messages yet. Open it in its terminal.');
  // smarty-code#126 F7 (c): plain words, no internal tool names.
  expect(html).not.toContain('Herdr');
  expect(html).not.toContain('href=');
  expect(html).not.toContain('No sessions');
});
