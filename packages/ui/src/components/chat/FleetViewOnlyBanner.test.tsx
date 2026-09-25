import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeCreationI18n } from '@/lib/i18n/messages/native-creation.i18n';

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof nativeCreationI18n.en) => nativeCreationI18n.en[key] ?? key }) }));
const { FleetViewOnlyBanner, FLEET_ENROLLMENT_URL } = await import('./FleetViewOnlyBanner');

test('the view-only banner names the reason and links to enrollment', () => {
  const html = renderToStaticMarkup(<FleetViewOnlyBanner />);
  expect(html).toContain('View only.');
  expect(html).toContain(`href="${FLEET_ENROLLMENT_URL}"`);
  expect(html).toContain('Learn more');
  expect(html).not.toContain('#116');
  expect(html).not.toContain('<textarea');
});
