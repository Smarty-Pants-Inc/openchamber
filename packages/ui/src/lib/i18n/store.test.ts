import { beforeEach, describe, expect, test } from 'bun:test';
import { brandText, PRODUCT_NAME } from '@/lib/brand.generated';
import { dict as frDict } from './messages/fr';
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
  test('renders product-owned labels as Smarty Code without rewriting parameters', () => {
    expect(PRODUCT_NAME).toBe('Smarty Code');
    expect(formatMessage(defaultDictionary, 'aboutDialog.openChamberVersionLabel', { version: 'OpenChamber' }))
      .toBe('Smarty Code version OpenChamber');
    expect(formatMessage(defaultDictionary, 'pwa.installPrompt.description'))
      .toBe('Install Smarty Code for quicker access');
    expect(formatMessage(defaultDictionary, 'chat.emptyState.opencodeUnreachable'))
      .toBe('Smarty Code is not reachable');
    expect(formatMessage(defaultDictionary, 'openCodeStatusDialog.title'))
      .toBe('Smarty Code Status');
    expect(formatMessage(defaultDictionary, 'opencodeUpdate.toast.upgrading.description'))
      .toBe('Keep Smarty Code open.');
  });

  test('brands the product-owned Settings restart action', () => {
    expect(formatMessage(defaultDictionary, 'settings.view.actions.reloadOpenCode'))
      .toBe(`Reload ${PRODUCT_NAME}`);
    expect(formatMessage(defaultDictionary, 'settings.view.actions.reloadOpenCodeTooltip'))
      .toBe(`Restart ${PRODUCT_NAME} and reload its configuration.`);
    expect(formatMessage(defaultDictionary, 'settings.view.actions.applyAndRestartOpenCodeTooltipSingle'))
      .toBe(`Apply 1 pending configuration change and restart ${PRODUCT_NAME}.`);
    expect(formatMessage(defaultDictionary, 'settings.view.actions.applyAndRestartOpenCodeTooltipPlural', { count: 2 }))
      .toBe(`Apply 2 pending configuration changes and restart ${PRODUCT_NAME}.`);
    expect(formatMessage(defaultDictionary, 'settings.view.pendingRestart.applied'))
      .toBe(`${PRODUCT_NAME} restarted with pending configuration changes.`);
    expect(formatMessage(defaultDictionary, 'settings.view.pendingRestart.manualRestartRequired'))
      .toBe(`Saved on disk. Restart your connected ${PRODUCT_NAME} server to apply the changes.`);
    expect(formatMessage(defaultDictionary, 'settings.view.pendingRestart.saved'))
      .toBe(`Saved. Restart ${PRODUCT_NAME} to apply.`);
    expect(formatMessage(defaultDictionary, 'settings.view.pendingRestart.confirm.description'))
      .toBe(`Restarting ${PRODUCT_NAME} will stop any running chats. Your saved configuration changes will take effect after the restart.`);
  });

  test('normalizes French OpenCode elisions in product-owned toast and Settings text', () => {
    expect(formatMessage(frDict, 'openCodeStatusDialog.toast.collectFailed'))
      .toBe('Impossible de recueillir l’état de Smarty Code');
    expect(formatMessage(frDict, 'settings.behavior.page.systemPromptOptimization.enableAria'))
      .toBe('Optimiser la taille du prompt système de Smarty Code');
    expect(formatMessage(frDict, 'settings.behavior.page.systemPromptOptimization.restarting'))
      .toBe('Redémarrage de Smarty Code pour appliquer l’optimisation du prompt système…');
  });

  test('retains upstream proper nouns only where they identify external artifacts', () => {
    const runtimeValue = 'OpenCode /tmp/OpenChamber https://provider.example/OpenCode';
    expect(formatMessage(defaultDictionary, 'aboutDialog.openCodeVersionLabel', { version: runtimeValue }))
      .toBe(`OpenCode version ${runtimeValue}`);
    expect(formatMessage(defaultDictionary, 'aboutDialog.diagnosticsDescription'))
      .toBe('Includes Smarty Code state, OpenCode health, directories, and projects.');
    expect(formatMessage(defaultDictionary, 'settings.view.nav.group.opencode'))
      .toBe('Smarty Code');
    expect(formatMessage(defaultDictionary, 'settings.openchamber.opencodeCli.title'))
      .toBe('OpenCode CLI');
    expect(formatMessage(defaultDictionary, 'opencodeUpdate.toast.actions.reload'))
      .toBe('Reload OpenCode');
    expect(formatMessage(frDict, 'settings.openchamber.about.field.openCodeVersion'))
      .toBe('Version d’OpenCode');
  });

  test('preserves technical OpenCode identifiers', () => {
    expect(brandText('OpenCode opencode OPENCODE_BINARY OpenCodeClient'))
      .toBe('Smarty Code opencode OPENCODE_BINARY OpenCodeClient');
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
