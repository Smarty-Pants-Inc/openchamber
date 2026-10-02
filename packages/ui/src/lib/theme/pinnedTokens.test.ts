import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { isValidTheme } from '@/contexts/theme-validation';
import type { Theme } from '@/types/theme';
import { buildTextMateThemeFromAppTheme } from '@/lib/shiki/textMateThemeFromAppTheme';
import { CSSVariableGenerator } from './cssGenerator';
import { getDefaultTheme } from './themes';
import { buildVSCodeThemeFromPalette } from './vscode/adapter';
import lightJSON from './themes/openchamber-light.json';
import darkJSON from './themes/openchamber-dark.json';

const tokenCSS = readFileSync(new URL('../../styles/vendor/smarty-design-system/tokens.css', import.meta.url), 'utf8');
const generator = new CSSVariableGenerator();
const designCSS = readFileSync(new URL('../../styles/design-system.css', import.meta.url), 'utf8');
const solidAliases = ['destructive-solid', 'destructive-solid-foreground', 'status-success-solid',
  'status-success-solid-foreground', 'status-warning-solid', 'status-warning-solid-foreground'];
const solidCSS = solidAliases.map((alias) => {
  const value = designCSS.match(new RegExp(`--color-${alias}: ([^;]+);`))?.[1];
  if (!value) throw new Error(`Missing solid alias ${alias}`);
  return `--${alias}: ${value};`;
}).join('\n');

// Parse the vendored declarations only in tests. JSON consumers receive resolved literals.
function declarations(variant: string): Map<string, string> {
  const block = tokenCSS.match(new RegExp(`\\[data-theme=${variant}\\]\\s*\\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing pinned ${variant} block`);
  return new Map(Array.from(block.matchAll(/--([\w-]+):\s*([^;]+);/g), (match) => [match[1], match[2].trim()]));
}

function resolve(source: Map<string, string>, token: string): string {
  const value = source.get(token);
  if (!value) throw new Error(`Missing pinned token ${token}`);
  const alias = value.match(/^var\(--([\w-]+)\)$/);
  return alias ? resolve(source, alias[1]) : value;
}

function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque hex color, received ${hex}`);
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const syntaxExtensionGroups: Array<[string, keyof Theme['colors']['syntax']['base']]> = [
  ['commentDoc', 'comment'], ['keywordImport', 'keyword'], ['storageModifier', 'keyword'],
  ['functionCall', 'function'], ['method', 'function'],
  ['variableProperty', 'variable'], ['variableOther', 'variable'], ['variableGlobal', 'variable'],
  ['variableLocal', 'variable'], ['parameter', 'variable'],
  ['class', 'type'], ['className', 'type'], ['interface', 'type'], ['struct', 'type'], ['enum', 'type'],
  ['typeParameter', 'type'], ['tagAttributeValue', 'string'],
];

// These independent extensions have no exact shared group. Do not assign them by old color equality.
const unmatchedExtensions = ['stringEscape', 'constant', 'namespace', 'module', 'tag', 'jsxTag', 'tagAttribute',
  'boolean', 'decorator', 'label', 'macro', 'preprocessor', 'regex', 'url', 'key', 'exception'];

describe('default JSON mirrors pinned Smarty tokens', () => {
  for (const theme of [lightJSON, darkJSON]) {
    test(`${theme.metadata.variant} raw and registered colors match literals and resolved aliases`, () => {
      expect(isValidTheme(theme)).toBe(true);
      if (!isValidTheme(theme)) throw new Error('Invalid default theme JSON');
      const source = declarations(theme.metadata.variant);
      const generatedCSS = generator.generate(getDefaultTheme(theme.metadata.variant === 'dark'));
      const rawCSS = generator.generate(theme);
      let matches = 0;
      for (const family of ['surface', 'interactive', 'primary', 'status'] as const) {
        for (const [field, value] of Object.entries(theme.colors[family])) {
          const token = `${family}-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
          if (!source.has(token)) continue;
          expect(value).toBe(resolve(source, token));
          expect(generatedCSS).toContain(`  --${token}: ${value};`);
          expect(rawCSS).toContain(`  --${token}: ${value};`);
          matches++;
        }
      }
      expect(matches).toBe(22);
      const syntaxGroups = ['comment', 'keyword', 'string', 'number', 'function', 'type', 'operator', 'variable'] as const;
      for (const group of syntaxGroups) {
        const value = theme.colors.syntax.base[group];
        expect(value).toBe(resolve(source, `syntax-${group}`));
        expect(generatedCSS).toContain(`  --syntax-${group}: ${value};`);
        expect(rawCSS).toContain(`  --syntax-${group}: ${value};`);
      }
      expect(theme.colors.syntax.tokens.punctuation).toBe(resolve(source, 'syntax-punctuation'));
      expect(generatedCSS).toContain(`  --syntax-punctuation: ${resolve(source, 'syntax-punctuation')};`);
      const textMate = buildTextMateThemeFromAppTheme(theme);
      for (const [rule, group] of [['comments', 'comment'], ['keywords', 'keyword'], ['strings', 'string'],
        ['numbers', 'number'], ['functions', 'function'], ['types', 'type'], ['operators', 'operator'],
        ['variables', 'variable'], ['punctuation', 'punctuation']]) {
        expect(textMate.tokenColors?.find((token) => token.name === rule)?.settings.foreground).toBe(resolve(source, `syntax-${group}`));
      }
      for (const [extension, group] of syntaxExtensionGroups) {
        expect(theme.colors.syntax.tokens[extension]).toBe(theme.colors.syntax.base[group]);
      }
      expect(Object.keys(theme.colors.syntax.tokens).filter((key) => key !== 'punctuation'
        && !syntaxExtensionGroups.some(([extension]) => extension === key))).toEqual(unmatchedExtensions);
      expect(theme.colors.surface.elevatedForeground).toBe(theme.colors.surface.foreground);
      expect(theme.colors.chat.assistantMessageBackground).toBe(theme.colors.surface.background);
      expect(theme.colors.tools.title).toBe(theme.colors.surface.foreground);
    });

    test(`${theme.metadata.variant} unshared status foregrounds retain their original solid-fill contract`, () => {
      const foreground = theme.metadata.variant === 'dark' ? '#000000' : '#ffffff';
      const source = declarations(theme.metadata.variant);
      const registered = getDefaultTheme(theme.metadata.variant === 'dark');
      for (const role of ['error', 'success', 'warning', 'info'] as const) {
        expect(source.has(`status-${role}-foreground`)).toBe(false);
        expect(theme.colors.status[`${role}Foreground`]).toBe(foreground);
        expect(registered.colors.status[`${role}Foreground`]).toBe(foreground);
        expect(generator.generate(registered)).toContain(`  --status-${role}-foreground: ${foreground};`);
      }
      expect(theme.colors.primary.foreground).toBe(resolve(source, 'primary-foreground'));
    });

    test(`${theme.metadata.variant} pin3 paired fills are explicit and raw JSON roles stay separate`, () => {
      const source = declarations(theme.metadata.variant);
      const expected = theme.metadata.variant === 'dark'
        ? ['#e8705f', '#a0af54', '#d0a215', '#66a0c8', '#1c1b1a']
        : ['#af3029', '#536907', '#8e6b01', '#205ea6', '#fffdf4'];
      for (const [index, role] of ['error', 'success', 'warning', 'info'].entries()) {
        const fill = resolve(source, `status-${role}-fill`);
        const foreground = resolve(source, `status-on-${role}-fill`);
        expect(fill).toBe(expected[index]);
        expect(foreground).toBe(expected[4]);
        expect(contrast(foreground, fill)).toBeGreaterThanOrEqual(4.5);
      }
    });

    test(`${theme.metadata.variant} solid aliases use pin3 pairs and restore exact selected fallbacks`, () => {
      const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
      const browser = new Window();
      Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document });
      try {
        const probe = browser.document.createElement('style');
        probe.textContent = `:root { --color-white: #fff; ${solidCSS} }`;
        browser.document.head.append(probe);
        const base = getDefaultTheme(theme.metadata.variant === 'dark');
        const custom: Theme = { ...base, colors: { ...base.colors, status: { ...base.colors.status,
          error: '#123456', errorForeground: '#abcdef', success: '#234567', warning: '#345678' },
          surface: { ...base.colors.surface, background: '#456789' } } };
        const vscode = buildVSCodeThemeFromPalette({ kind: theme.metadata.variant === 'dark' ? 'dark' : 'light', colors: {} });
        const source = declarations(theme.metadata.variant);
        for (const selected of [base, custom, vscode, base]) {
          const pinned = selected === base;
          generator.apply(selected, pinned ? tokenCSS : '');
          const css = browser.getComputedStyle(browser.document.documentElement);
          const value = (name: string) => css.getPropertyValue(`--${name}`).trim();
          expect(value('destructive')).toBe(selected.colors.status.error);
          expect(value('destructive-foreground')).toBe(selected.colors.status.errorForeground);
          for (const [alias, role, fallback] of [
            ['destructive-solid', 'error', selected.colors.status.errorForeground],
            ['status-success-solid', 'success', '#fff'],
            ['status-warning-solid', 'warning', selected.colors.surface.background],
          ]) {
            const fill = value(alias);
            const foreground = value(`${alias}-foreground`);
            const rawFill = role === 'error' ? selected.colors.status.error
              : role === 'success' ? selected.colors.status.success : selected.colors.status.warning;
            expect(fill).toBe(pinned ? resolve(source, `status-${role}-fill`) : rawFill);
            expect(foreground).toBe(pinned ? resolve(source, `status-on-${role}-fill`) : fallback);
            if (pinned) expect(contrast(foreground, fill)).toBeGreaterThanOrEqual(4.5);
          }
          expect(value('status-info-fill')).toBe(pinned ? resolve(source, 'status-info-fill') : '');
        }
      } finally {
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
        else Reflect.deleteProperty(globalThis, 'document');
        browser.happyDOM.abort();
      }
    });

    test(`${theme.metadata.variant} mono font mirrors the shared stack without mapping other typography or spacing`, () => {
      const mono = resolve(declarations('light'), 'type-font-mono');
      expect(theme.config.fonts.mono).toBe(mono);
      const css = generator.generate(getDefaultTheme(theme.metadata.variant === 'dark'));
      expect(css).toContain(`  --font-mono: ${mono};`);
      expect(css).toContain(`  --font-family-mono: ${mono};`);
      expect(css).not.toContain('--type-size-');
      expect(css).not.toContain('--space-');
    });
  }
});
