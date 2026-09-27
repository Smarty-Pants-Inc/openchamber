import React from 'react';
import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { ManagedSessionHoldNoticeView } from './ManagedSessionHoldNotice';

const render = (notArrived: boolean) => renderToString(
  <I18nProvider><ManagedSessionHoldNoticeView notArrived={notArrived} onShowProjects={() => {}} /></I18nProvider>,
);

test('while the project loads the notice says it is waiting, with no control', () => {
  const html = render(false);
  expect(html).toContain('Waiting for this project to finish loading…');
  expect(html).not.toContain('<button');
});

test('after the bounded wait the notice says the project is not in the live catalog and offers the project list', () => {
  const html = render(true);
  expect(html).toContain('This session&#x27;s project is not in the live catalog.');
  expect(/<button[^>]*>Show projects<\/button>/.test(html)).toBe(true);
});
