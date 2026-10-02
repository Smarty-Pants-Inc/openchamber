import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { Theme } from '@/types/theme';
import { CSSVariableGenerator } from './cssGenerator';
import { getDefaultTheme, themes } from './themes';
import { buildVSCodeThemeFromPalette, type VSCodeThemeKind } from './vscode/adapter';
import { isValidTheme } from '@/contexts/theme-validation';
import { getSyncedThemeFromPayload } from '@/contexts/theme-sync-payload';
import { withPrColors } from './themes/prColors';

const generator = new CSSVariableGenerator();
const pinnedCSS = new URL('../../styles/vendor/smarty-design-system/tokens.css', import.meta.url);
const tokenCSS = readFileSync(pinnedCSS, 'utf8');

function aliases(theme: Theme): Array<[string, string, string | undefined]> {
  const { surface, interactive, primary, status } = theme.colors;
  return [
    ['background', 'surface-background', surface.background],
    ['foreground', 'surface-foreground', surface.foreground],
    ['muted', 'surface-muted', surface.muted],
    ['muted-foreground', 'surface-muted-foreground', surface.mutedForeground],
    ['card', 'surface-elevated', surface.elevated],
    ['card-foreground', 'surface-elevated-foreground', surface.elevatedForeground],
    ['popover', 'surface-elevated', surface.elevated],
    ['popover-foreground', 'surface-elevated-foreground', surface.elevatedForeground],
    ['border', 'interactive-border', interactive.border],
    ['input', 'interactive-border', interactive.border],
    ['primary', 'primary-base', primary.base],
    ['secondary', 'surface-muted', surface.muted],
    ['secondary-foreground', 'surface-muted-foreground', surface.mutedForeground],
    ['accent', 'surface-subtle', surface.subtle],
    ['accent-foreground', 'surface-foreground', surface.foreground],
    ['destructive', 'status-error', status.error],
    ['destructive-foreground', 'status-error-foreground', status.errorForeground],
    ['ring', 'interactive-focus-ring', interactive.focusRing],
    ['sidebar-foreground', 'surface-muted-foreground', surface.mutedForeground],
    ['sidebar-primary', 'primary-base', primary.base],
    ['sidebar-primary-foreground', 'primary-foreground', primary.foreground],
    ['sidebar-accent-base', 'surface-subtle', surface.subtle],
    ['sidebar-accent-foreground', 'surface-foreground', surface.foreground],
    ['sidebar-border', 'interactive-border', interactive.border],
    ['sidebar-ring', 'interactive-focus-ring', interactive.focusRing],
  ];
}

const customThemes: Theme[] = ['light', 'dark'].map((variant) => {
  const base = getDefaultTheme(variant === 'dark');
  return {
    ...base,
    metadata: { ...base.metadata, id: `custom-${variant}` },
    colors: {
      ...base.colors,
      surface: { ...base.colors.surface, sidebar: undefined, muted: '#12345690', elevated: '#abcdef90' },
      primary: { ...base.colors.primary, base: 'rgb(12, 34, 56)' },
    },
  };
});
const vscodeKinds: VSCodeThemeKind[] = ['light', 'dark', 'high-contrast'];
const vscodeThemes = vscodeKinds.map((kind) =>
  buildVSCodeThemeFromPalette({
    kind,
    colors: { 'button.background': '#123456', 'input.background': 'rgba(12, 34, 56, 0.5)', 'chat.requestBackground': '#654321' },
  }),
);

describe('CSSVariableGenerator semantic aliases', () => {
  for (const theme of [...themes, ...customThemes, ...vscodeThemes]) {
    test(`${theme.metadata.id} ${theme.metadata.variant} retains colors and exact literal fallbacks`, () => {
      const css = generator.generate(theme);
      for (const [alias, semantic, fallback] of aliases(theme)) {
        expect(css).toContain(`  --${alias}: var(--${semantic}, ${fallback}) !important;`);
        expect(css).toContain(`  --${semantic}: ${fallback};`);
      }
      expect(css).toContain(`  --sidebar-base: var(--surface-sidebar, var(--surface-muted, ${theme.colors.surface.muted})) !important;`);
      expect(css).toContain(`  --surface-sidebar: ${theme.colors.surface.sidebar || theme.colors.surface.muted};`);
      expect(css).toContain('  --sidebar: var(--sidebar-base) !important;');
      expect(css).toContain('  --sidebar-accent: var(--sidebar-accent-base) !important;');
      expect(css.match(/--primary-foreground:/g)).toHaveLength(1);
      for (const match of css.matchAll(/(--[\w-]+): var\((--[\w-]+)/g)) {
        expect(match[1]).not.toBe(match[2]);
      }
    });
  }

  test('primary foreground keeps its semantic default when omitted', () => {
    const base = getDefaultTheme(true);
    const theme: Theme = { ...base, colors: { ...base.colors, primary: { base: base.colors.primary.base } } };
    const css = generator.generate(theme);
    expect(css).toContain('  --primary-foreground: #ffffff;');
    expect(css.match(/--primary-foreground:/g)).toHaveLength(1);
    expect(css).not.toContain('--primary-foreground: var(');
  });

  test('loading uses semantics only for absent or empty overrides', () => {
    const base = getDefaultTheme(true);
    const loadingCases: Theme['colors']['loading'][] = [
      undefined, {}, { spinner: '', spinnerTrack: '' },
      { spinner: '#123456' }, { spinnerTrack: '#abcdef' },
      { spinner: '#123456', spinnerTrack: '#abcdef' },
    ];
    for (const loading of loadingCases) {
      const theme: Theme = { ...base, colors: { ...base.colors, loading } };
      const css = generator.generate(theme);
      expect(css).toContain(`  --loading-spinner: ${loading?.spinner || `var(--primary-base, ${base.colors.primary.base})`};`);
      expect(css).toContain(`  --loading-spinner-track: ${loading?.spinnerTrack || `var(--surface-muted, ${base.colors.surface.muted})`};`);
    }
  });

  test('apply replaces raw overrides, preserves their bytes, and clears them for other themes', () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const browser = new Window();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document });
    try {
      const defaults = [getDefaultTheme(true), getDefaultTheme(false)];
      const sameIdThemes = defaults.map((theme): Theme => ({ ...theme, colors: { ...theme.colors,
        primary: { ...theme.colors.primary, text: '#abcdef' },
        status: { ...theme.colors.status, errorText: '#abcdef', successText: '#abcdef', warningText: '#abcdef', infoText: '#abcdef' },
      }, config: { ...theme.config, fonts: { mono: 'Custom Mono, monospace' } } }));
      const hmrPayload = JSON.parse(JSON.stringify({ ...sameIdThemes[0], config: { fonts: { mono: 'HMR Mono, monospace' } } }));
      if (!isValidTheme(hmrPayload)) throw new Error('Invalid HMR payload');
      const hmrTheme = withPrColors(hmrPayload);
      const embeddedTheme = getSyncedThemeFromPayload({ currentTheme: JSON.parse(JSON.stringify({ ...sameIdThemes[1],
        config: { fonts: { mono: 'Embedded Mono, monospace' } },
      })) });
      if (!embeddedTheme) throw new Error('Invalid embedded payload');
      const sequence = [...defaults, ...customThemes, ...sameIdThemes, hmrTheme, embeddedTheme, ...vscodeThemes, ...defaults];
      const root = browser.document.documentElement;
      // User and VS Code font preferences are inline and must beat theme defaults.
      root.style.setProperty('--font-mono', 'User Mono, monospace');
      root.style.setProperty('--font-family-mono', 'User Mono, monospace');
      for (const theme of sequence) {
        const raw = defaults.includes(theme) ? tokenCSS : '';
        generator.apply(theme, raw);
        const root = browser.document.documentElement;
        const styles = browser.document.querySelectorAll('#opencode-theme-variables');
        expect(styles.length).toBe(1);
        const css = generator.generate(theme);
        const selector = theme.metadata.variant === 'dark' ? ':where(.dark)' : ':where(:root:not(.dark))';
        const fallbackCSS = `:where(:root) {\n${css}\n}\n\n${selector} {\n${css}\n}`;
        expect(styles[0].textContent).toBe(raw ? `${fallbackCSS}\n\n${raw}` : fallbackCSS);
        expect(styles[0].textContent?.includes('--accent-blue:')).toBe(Boolean(raw));
        expect(root.classList.contains(theme.metadata.variant)).toBe(true);
        expect(root.classList.contains(theme.metadata.variant === 'dark' ? 'light' : 'dark')).toBe(false);
        expect(root.getAttribute('data-theme')).toBe(theme.metadata.variant);
        for (const [, semantic, fallback] of aliases(theme)) {
          expect(styles[0].textContent).toContain(`  --${semantic}: ${fallback};`);
        }
        expect(styles[0].textContent).toContain(`  --primary-text: ${theme.colors.primary.text || theme.colors.primary.base};`);
        expect(browser.getComputedStyle(root).getPropertyValue('--primary-text')).toBe(theme.colors.primary.text || theme.colors.primary.base);
        expect(styles[0].textContent?.includes('--type-font-mono:')).toBe(Boolean(raw));
        for (const role of ['error', 'success', 'warning', 'info'] as const) {
          expect(styles[0].textContent).toContain(`  --status-${role}-text: ${theme.colors.status[`${role}Text`] || theme.colors.status[role]};`);
          expect(browser.getComputedStyle(root).getPropertyValue(`--status-${role}-text`)).toBe(theme.colors.status[`${role}Text`] || theme.colors.status[role]);
        }
        if (theme.config?.fonts?.mono) expect(styles[0].textContent).toContain(`  --font-mono: ${theme.config.fonts.mono};`);
        expect(browser.getComputedStyle(root).getPropertyValue('--font-mono')).toBe('User Mono, monospace');
        expect(browser.getComputedStyle(root).getPropertyValue('--font-family-mono')).toBe('User Mono, monospace');
      }
      root.style.removeProperty('--font-mono');
      root.style.removeProperty('--font-family-mono');
      for (const theme of [...sameIdThemes, hmrTheme, embeddedTheme, ...defaults]) {
        generator.apply(theme, defaults.includes(theme) ? tokenCSS : '');
        expect(browser.getComputedStyle(root).getPropertyValue('--font-mono')).toBe(theme.config?.fonts?.mono);
        expect(browser.getComputedStyle(root).getPropertyValue('--font-family-mono')).toBe(theme.config?.fonts?.mono);
      }
      for (const theme of defaults) {
        const conflicting: Theme = { ...theme, colors: { ...theme.colors,
          surface: { ...theme.colors.surface, background: '#123456', muted: '#654321', sidebar: undefined },
          primary: { ...theme.colors.primary, foreground: '#abcdef' },
        } };
        generator.apply(conflicting, tokenCSS);
        const root = browser.document.documentElement;
        const computed = () => browser.getComputedStyle(root);
        expect(computed().getPropertyValue('--background')).toBe(theme.colors.surface.background);
        expect(computed().getPropertyValue('--sidebar-base')).toBe(theme.colors.surface.sidebar);
        expect(computed().getPropertyValue('--primary-foreground')).toBe(theme.colors.primary.foreground);
        generator.apply(conflicting);
        expect(computed().getPropertyValue('--background')).toBe('#123456');
        expect(computed().getPropertyValue('--sidebar-base')).toBe('#654321');
        expect(computed().getPropertyValue('--primary-foreground')).toBe('#abcdef');
        expect(computed().getPropertyValue('--accent-blue')).toBe('');
      }
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      browser.happyDOM.abort();
    }
  });
});
