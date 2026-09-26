import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { UnsavedLabel } from './UnsavedLabel';
import { isUnsaved } from './unsaved';

// Slice 1 L1: a record Pi holds in memory but has not written to the session file carries
// info.metadata.smartyCodeUnsaved: true; its row shows a small 'Unsaved' label. Absent means saved.
const render = (info: unknown) => renderToStaticMarkup(<I18nProvider><UnsavedLabel info={info} /></I18nProvider>);

test('an unsaved record shows the label with its explanation', () => {
  const html = render({ id: 'm1', metadata: { smartyCodeUnsaved: true } });
  expect(html).toContain('>Unsaved<');
  expect(html).toContain('title="Pi has this message, but it is not in the session file yet."');
});

test('a saved record, or anything but exactly true, shows nothing', () => {
  for (const info of [{ id: 'm1' }, { metadata: {} }, { metadata: { smartyCodeUnsaved: false } },
    { metadata: { smartyCodeUnsaved: 'true' } }, { metadata: { smartyCodeUnsaved: 1 } }, null, undefined]) {
    expect(isUnsaved(info)).toBe(false);
    expect(render(info)).toBe('');
  }
});

test('both message rows render it: the user bubble (beside the author) and the assistant row', async () => {
  // ChatMessage needs the whole app to mount; like issue-2903's container checks, this reads its source.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./ChatMessage.tsx', import.meta.url), 'utf8');
  expect(/<HumanAuthor info=\{message\.info\} \/>\s*<UnsavedLabel info=\{message\.info\} \/>/.test(source)).toBe(true);
  expect(/<div className="relative">\s*<UnsavedLabel info=\{message\.info\} \/>\s*<MessageBody/.test(source)).toBe(true);
});
