import { expect, test } from 'bun:test';
import { attachmentI18n } from './attachment.i18n';
import { LOCALES } from '../runtime';

const keys = [
  'chat.chatInput.attachments.supportedTypes',
  'chat.chatInput.toast.attachmentUnsupported',
  'chat.chatInput.toast.zipUnsupported',
] as const;

test('every supported locale explains attachment types and ZIP refusal', async () => {
  for (const locale of LOCALES) {
    const { dict } = await import(`./${locale}.ts`);
    for (const key of keys) {
      const value = attachmentI18n[locale][key];
      expect(value.length).toBeGreaterThan(0);
      expect(dict[key]).toBe(value);
      if (locale !== 'en') expect(value).not.toBe(attachmentI18n.en[key]);
    }
    expect(attachmentI18n[locale]['chat.chatInput.toast.attachmentUnsupported']).toContain('{name}');
  }
});
