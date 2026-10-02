import { describe, expect, test } from 'bun:test';
import { isValidTheme } from '@/contexts/theme-validation';
import { CSSVariableGenerator } from './cssGenerator';
import { getDefaultTheme, themes } from './themes';
import { buildVSCodeThemeFromPalette } from './vscode/adapter';

const generator = new CSSVariableGenerator();
const invalidColors = [undefined, null, 42, true, {}, [], ['#abcdef'], '', ' \t\n '];

describe('optional theme colors at the parsed JSON boundary', () => {
  for (const dark of [false, true]) {
    const base = getDefaultTheme(dark);
    test(`${base.metadata.variant} malformed sidebar falls back to the selected muted color`, () => {
      for (const sidebar of invalidColors) {
        const parsed = JSON.parse(JSON.stringify({
          ...base,
          colors: { ...base.colors, surface: { ...base.colors.surface, muted: '#12345690', sidebar } },
        }));
        // The loader accepts these optional fields, including custom replacements with a built-in ID.
        expect(isValidTheme(parsed)).toBe(true);
        if (!isValidTheme(parsed)) throw new Error('Expected loader acceptance');
        expect(parsed.metadata.id).toBe(base.metadata.id);
        const css = generator.generate(parsed);
        expect(css).toContain('  --surface-sidebar: #12345690;');
        expect(css).toContain('  --sidebar-base: var(--surface-sidebar, var(--surface-muted, #12345690)) !important;');
        expect(css).toContain('  --sidebar-base-rgb: 18 52 86 !important;');
        expect(css).toContain(`  --sidebar-overlay-strong: rgb(18 52 86 / ${dark ? 0.15 : 0.5}) !important;`);
        expect(css).toContain(`  --sidebar-overlay-soft: rgb(18 52 86 / ${dark ? 0.1 : 0.3}) !important;`);
      }
    });

    test(`${base.metadata.variant} malformed sidebar also follows a CSS variable muted fallback`, () => {
      for (const sidebar of invalidColors) {
        const parsed = JSON.parse(JSON.stringify({ ...base,
          colors: { ...base.colors, surface: { ...base.colors.surface, muted: 'var(--selected-muted)', sidebar } },
        }));
        if (!isValidTheme(parsed)) throw new Error('Expected loader acceptance');
        const css = generator.generate(parsed);
        expect(css).toContain('  --surface-sidebar: var(--selected-muted);');
        expect(css).not.toContain('--sidebar-base-rgb:');
        expect(css).toContain('  --sidebar-overlay-strong: var(--selected-muted) !important;');
        expect(css).toContain('  --sidebar-overlay-soft: var(--selected-muted) !important;');
      }
    });

    test(`${base.metadata.variant} explicit hex and CSS variable sidebar values survive`, () => {
      for (const [sidebar, rgb] of [['#abc', '170 187 204'], [' #12345678 ', '18 52 86'], [' var(--custom-sidebar) ', '']]) {
        const theme = { ...base, colors: { ...base.colors, surface: { ...base.colors.surface, sidebar } } };
        const css = generator.generate(theme);
        expect(css).toContain(`  --surface-sidebar: ${sidebar.trim()};`);
        if (rgb) {
          expect(css).toContain(`  --sidebar-base-rgb: ${rgb} !important;`);
          expect(css).toContain(`  --sidebar-overlay-strong: rgb(${rgb} / ${dark ? 0.15 : 0.5}) !important;`);
        } else {
          expect(css).not.toContain('--sidebar-base-rgb:');
          expect(css).toContain('  --sidebar-overlay-strong: var(--custom-sidebar) !important;');
          expect(css).toContain('  --sidebar-overlay-soft: var(--custom-sidebar) !important;');
        }
      }
    });

    test(`${base.metadata.variant} invalid optional text colors use selected fills without changing fills`, () => {
      for (const text of invalidColors) {
        const parsed = JSON.parse(JSON.stringify({
          ...base,
          colors: {
            ...base.colors,
            primary: { ...base.colors.primary, base: '#123456', text },
            status: { ...base.colors.status, error: '#234567', success: '#345678', warning: '#456789', info: '#56789a',
              errorText: text, successText: text, warningText: text, infoText: text },
          },
        }));
        expect(isValidTheme(parsed)).toBe(true);
        if (!isValidTheme(parsed)) throw new Error('Expected loader acceptance');
        const css = generator.generate(parsed);
        expect(css).toContain('  --primary-base: #123456;');
        expect(css).toContain('  --primary-text: #123456;');
        for (const role of ['error', 'success', 'warning', 'info'] as const) {
          expect(css).toContain(`  --status-${role}: ${parsed.colors.status[role]};`);
          expect(css).toContain(`  --status-${role}-text: ${parsed.colors.status[role]};`);
        }
      }
    });

    test(`${base.metadata.variant} explicit text colors preserve hex and CSS variable values`, () => {
      for (const text of [' #abcdef ', ' var(--custom-text) ']) {
        const theme = { ...base, colors: { ...base.colors,
          primary: { ...base.colors.primary, text },
          status: { ...base.colors.status, errorText: text, successText: text, warningText: text, infoText: text },
        } };
        const css = generator.generate(theme);
        expect(css).toContain(`  --primary-text: ${text.trim()};`);
        expect(css).toContain(`  --primary-base: ${base.colors.primary.base};`);
        for (const role of ['error', 'success', 'warning', 'info'] as const) {
          expect(css).toContain(`  --status-${role}-text: ${text.trim()};`);
          expect(css).toContain(`  --status-${role}: ${base.colors.status[role]};`);
        }
      }
    });
  }

  test('all bundled and VS Code themes emit text tokens using their own optional values or fills', () => {
    const vscodeThemes = [buildVSCodeThemeFromPalette({ kind: 'dark', colors: { 'button.background': '#123456' } }),
      buildVSCodeThemeFromPalette({ kind: 'light', colors: {} }),
      buildVSCodeThemeFromPalette({ kind: 'high-contrast', colors: {} })];
    for (const theme of [...themes, ...vscodeThemes]) {
      const css = generator.generate(theme);
      expect(css).toContain(`  --primary-text: ${theme.colors.primary.text || theme.colors.primary.base};`);
      for (const role of ['error', 'success', 'warning', 'info'] as const) {
        expect(css).toContain(`  --status-${role}-text: ${theme.colors.status[`${role}Text`] || theme.colors.status[role]};`);
      }
    }
  });
});
