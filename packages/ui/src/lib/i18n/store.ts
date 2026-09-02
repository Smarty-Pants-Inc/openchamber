import { create } from 'zustand';
import { brandProductText, brandText, PRODUCT_NAME } from '@/lib/brand.generated';

import { dict as enDict, type I18nKey } from './messages/en';
import { DEFAULT_LOCALE, detectInitialLocale, type Locale, writeStoredLocale } from './runtime';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;
export type I18nDictionary = Record<I18nKey, string>;

type I18nState = {
  locale: Locale;
  dictionary: I18nDictionary;
  loadingLocale: Locale | null;
  setLocale: (locale: Locale) => void;
};

const dictionaries = new Map<Locale, I18nDictionary>([[DEFAULT_LOCALE, enDict]]);

// User-facing copy is branded as Smarty Code by default. The small exception
// list names upstream OpenCode products or artifacts that users must identify
// accurately (the CLI, update channel, diagnostics, official docs, and Go).
const UPSTREAM_OPEN_CODE_KEYS: Partial<Record<I18nKey, true>> = {
  'aboutDialog.openCodeVersionLabel': true,
  'aboutDialog.diagnosticsDescription': true,
  'onboarding.localSetup.description': true,
  'onboarding.localSetup.errors.cliNotReady': true,
  'onboarding.localSetup.windows.stepInstallWsl': true,
  'onboarding.localSetup.windows.stepSetBinaryPath': true,
  'onboarding.localSetup.intro': true,
  'onboarding.localSetup.docs.windows': true,
  'onboarding.localSetup.docs.default': true,
  'onboarding.localSetup.helper.checkAndContinue': true,
  'onboarding.localSetup.status.watching': true,
  'onboarding.localSetup.field.alreadyInstalled': true,
  'onboarding.localSetup.helper.saveAndReload': true,
  'onboarding.localSetup.windows.hintInstallInWsl': true,
  'onboarding.desktopRecovery.localUnavailable.description': true,
  'opencodeUpdate.toast.available.title': true,
  'opencodeUpdate.toast.actions.reload': true,
  'opencodeUpdate.toast.upgrading.title': true,
  'opencodeUpdate.toast.updated.title': true,
  'opencodeUpdate.toast.failed.title': true,
  'opencodeUpdate.toast.failed.description': true,
  'opencodeUpdate.toast.reload.message': true,
  'settings.providers.page.openCodeGo.title': true,
  'settings.providers.page.openCodeGo.description': true,
  'settings.providers.page.openCodeGo.saveFailed': true,
  'settings.providers.page.openCodeGo.valid': true,
  'settings.providers.page.openCodeGo.invalid': true,
  'settings.providers.page.openCodeGo.deleted': true,
  'settings.providers.page.openCodeGo.deleteFailed': true,
  'settings.openchamber.about.field.openCodeVersion': true,
  'settings.openchamber.opencodeCli.title': true,
  'settings.openchamber.opencodeCli.field.binaryPath': true,
  'settings.openchamber.opencodeCli.field.showUpdateNotifications': true,
  'settings.openchamber.opencodeCli.field.showUpdateNotificationsAria': true,
  'settings.openchamber.opencodeCli.actions.browseAria': true,
  'settings.openchamber.opencodeCli.actions.restartingOpenCode': true,
  'settings.providers.page.custom.field.apiKey.info': true,
  'settings.providers.page.auth.apiKeyTooltip': true,
};

const normalizeOpenCodeElisions = (value: string): string => value.replace(/([dDlL])([’'])OpenCode\b/g, (match, prefix, _apostrophe, offset, input) => {
  if (offset > 0 && /\w/.test(input[offset - 1])) return match;
  return prefix === 'D' ? `De ${PRODUCT_NAME}` : prefix === 'L' ? `Le ${PRODUCT_NAME}` : prefix === 'd' ? `de ${PRODUCT_NAME}` : `le ${PRODUCT_NAME}`;
});

export function resetI18nDictionaryCacheForTests(): void {
  dictionaries.clear();
  dictionaries.set(DEFAULT_LOCALE, enDict);
}

async function loadDictionary(locale: Locale): Promise<I18nDictionary> {
  const cached = dictionaries.get(locale);
  if (cached) {
    return cached;
  }

  const mod = locale === 'zh-CN'
    ? await import('./messages/zh-CN') as { dict: I18nDictionary }
    : locale === 'fr'
      ? await import('./messages/fr') as { dict: I18nDictionary }
    : locale === 'zh-TW'
      ? await import('./messages/zh-TW') as { dict: I18nDictionary }
      : locale === 'es'
        ? await import('./messages/es') as { dict: I18nDictionary }
        : locale === 'pt-BR'
          ? await import('./messages/pt-BR') as { dict: I18nDictionary }
          : locale === 'uk'
            ? await import('./messages/uk') as { dict: I18nDictionary }
            : locale === 'ko'
              ? await import('./messages/ko') as { dict: I18nDictionary }
              : locale === 'pl'
                ? await import('./messages/pl') as { dict: I18nDictionary }
                : locale === 'de'
                  ? await import('./messages/de') as { dict: I18nDictionary }
                  : locale === 'ja'
                    ? await import('./messages/ja') as { dict: I18nDictionary }
                    : { dict: enDict };
  dictionaries.set(locale, mod.dict);
  return mod.dict;
}

export const useI18nStore = create<I18nState>()((set, get) => ({
  locale: DEFAULT_LOCALE,
  dictionary: enDict,
  loadingLocale: null,
  setLocale: (locale) => {
    const current = get();
    const cached = dictionaries.get(locale);
    if (current.locale === locale && current.loadingLocale !== locale && cached) {
      return;
    }

    writeStoredLocale(locale);

    set({
      locale,
      dictionary: cached ?? current.dictionary,
      loadingLocale: cached ? null : locale,
    });

    if (cached) {
      return;
    }

    void loadDictionary(locale).then((dictionary) => {
      if (get().locale !== locale) {
        return;
      }
      set({ dictionary, loadingLocale: null });
    }).catch((error) => {
      console.error(`[i18n] failed to load locale ${locale}`, error);
      if (get().locale === locale) {
        set({ dictionary: enDict, loadingLocale: null });
      }
    });
  },
}));

export function initializeLocale(): void {
  useI18nStore.getState().setLocale(detectInitialLocale());
}

export function formatMessage(dictionary: I18nDictionary, key: I18nKey, params?: I18nParams): string {
  const sourceTemplate = dictionary[key] ?? enDict[key] ?? key;
  const productTemplate = brandProductText(sourceTemplate);
  const template = UPSTREAM_OPEN_CODE_KEYS[key] === true
    ? productTemplate
    : brandText(normalizeOpenCodeElisions(productTemplate));
  if (!params) {
    return template;
  }

  return template.replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const value = params[rawKey.trim()];
    return value === null || value === undefined ? match : String(value);
  });
}

export type { I18nKey, Locale };
