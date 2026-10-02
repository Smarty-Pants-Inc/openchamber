import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { Theme } from '@/types/theme';
import { CSSVariableGenerator } from './cssGenerator';
import { getDefaultTheme, themes } from './themes';
import { buildVSCodeThemeFromPalette, type VSCodeThemeKind } from './vscode/adapter';
import lightJSON from './themes/openchamber-light.json';
import darkJSON from './themes/openchamber-dark.json';

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

  test('raw default JSON and generated colors match every shared semantic literal in both modes', () => {
    for (const theme of [lightJSON, darkJSON]) {
      const block = tokenCSS.match(new RegExp(`\\[data-theme=${theme.metadata.variant}\\]\\s*\\{([^}]+)\\}`))?.[1];
      expect(block).toBeDefined();
      const source = new Map(Array.from((block ?? '').matchAll(/--([\w-]+):\s*(#[\da-f]+);/gi), (match) => [match[1], match[2]]));
      let matches = 0;
      const generatedCSS = generator.generate(getDefaultTheme(theme.metadata.variant === 'dark'));
      for (const family of ['surface', 'interactive', 'primary', 'status'] as const) {
        for (const [field, value] of Object.entries(theme.colors[family])) {
          const token = `${family}-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
          if (!source.has(token)) continue;
          expect(value).toBe(source.get(token));
          expect(generatedCSS).toContain(`  --${token}: ${value};`);
          matches++;
        }
      }
      expect(matches).toBe(15);
      expect(theme.colors.surface.elevatedForeground).toBe(theme.colors.surface.foreground);
      expect(theme.colors.chat.assistantMessageBackground).toBe(theme.colors.surface.background);
      expect(theme.colors.tools.title).toBe(theme.colors.surface.foreground);
    }
  });

  test('apply replaces raw overrides, preserves their bytes, and clears them for other themes', () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const browser = new Window();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document });
    try {
      const defaults = [getDefaultTheme(true), getDefaultTheme(false)];
      const sequence = [...defaults, ...customThemes, ...vscodeThemes, { ...defaults[0] }, defaults[0]];
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
