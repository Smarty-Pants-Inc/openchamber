import { beforeEach, describe, expect, test } from 'bun:test';
import { brandText, PRODUCT_NAME } from '@/lib/brand.generated';
import { DEFAULT_LOCALE, type Locale } from './runtime';
import { formatMessage, resetI18nDictionaryCacheForTests, useI18nStore } from './store';

const defaultDictionary = useI18nStore.getState().dictionary;

const resetStore = () => {
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({
    locale: DEFAULT_LOCALE,
    dictionary: defaultDictionary,
    loadingLocale: null,
  });
};

const waitForLocaleLoadToSettle = async (locale: Locale) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (useI18nStore.getState().loadingLocale !== locale) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${locale} dictionary load`);
};

describe('i18n store', () => {
  beforeEach(resetStore);
  test('brands product-owned templates without rewriting parameters', () => {
    expect(formatMessage(defaultDictionary, 'aboutDialog.openChamberVersionLabel', { version: 'OpenChamber' }))
      .toBe(`${PRODUCT_NAME} version OpenChamber`);
    expect(formatMessage(defaultDictionary, 'pwa.installPrompt.description'))
      .toBe(`Install ${PRODUCT_NAME} for quicker access`);
    expect(formatMessage(defaultDictionary, 'opencodeUpdate.toast.upgrading.description'))
      .toBe(`Keep ${PRODUCT_NAME} open.`);
  });

  test('preserves upstream OpenCode labels and mixed diagnostics', () => {
    const runtimeValue = 'OpenCode /tmp/OpenChamber https://provider.example/OpenCode';
    expect(formatMessage(defaultDictionary, 'aboutDialog.openCodeVersionLabel', { version: runtimeValue }))
      .toBe(`OpenCode version ${runtimeValue}`);
    expect(formatMessage(defaultDictionary, 'aboutDialog.diagnosticsDescription'))
      .toBe(`Includes ${PRODUCT_NAME} state, OpenCode health, directories, and projects.`);
  });

  test('preserves technical OpenCode identifiers', () => {
    expect(brandText('OpenCode opencode OPENCODE_BINARY OpenCodeClient'))
      .toBe(`${PRODUCT_NAME} opencode OPENCODE_BINARY OpenCodeClient`);
  });

  test('retries loading the active locale when it is not cached', async () => {
    useI18nStore.setState({
      locale: 'es',
      dictionary: defaultDictionary,
      loadingLocale: null,
    });

    try {
      useI18nStore.getState().setLocale('es');

      expect(useI18nStore.getState().loadingLocale).toBe('es');
      await waitForLocaleLoadToSettle('es');
    } finally {
      resetStore();
    }
  });

  test('loads the french dictionary', async () => {
    try {
      useI18nStore.getState().setLocale('fr');

      expect(useI18nStore.getState().loadingLocale).toBe('fr');
      await waitForLocaleLoadToSettle('fr');
      expect(useI18nStore.getState().dictionary['common.language.french']).toBe('Français');
    } finally {
      resetStore();
    }
  });
});
