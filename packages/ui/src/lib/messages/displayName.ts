import { z } from 'zod';

// Display attribution only. This value must never select access, roles or session ownership.
export const displayNameSchema = z.string().min(1).max(64)
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .'-]*$/u)
  .refine((name) => name.trim() === name && new TextEncoder().encode(name).length <= 128);

export const DISPLAY_NAME_KEY = 'smarty-code.display-name.v1';

/** Per-tab browser state survives reload without sharing names with another tab. */
export function readDisplayName(storage: Pick<Storage, 'getItem'>): string | undefined {
  const value = storage.getItem(DISPLAY_NAME_KEY);
  return value === null || value === '' ? undefined : displayNameSchema.parse(value);
}

export function saveDisplayName(storage: Pick<Storage, 'setItem' | 'removeItem'>, name: string): void {
  if (name === '') storage.removeItem(DISPLAY_NAME_KEY);
  else storage.setItem(DISPLAY_NAME_KEY, displayNameSchema.parse(name));
}

type DisplayNameStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** One applied-choice authority per tab; an explicit unnamed override needs no storage. */
export function createDisplayNameChoice(storage: () => DisplayNameStorage) {
  let unnamedForTab = false;
  return {
    get unnamedForTab() { return unnamedForTab; },
    read: () => unnamedForTab ? undefined : readDisplayName(storage()),
    apply(name: string) {
      saveDisplayName(storage(), name);
      unnamedForTab = false;
    },
    useUnnamedForTab() { unnamedForTab = true; },
  };
}

// Lazy access also lets the explicit unnamed choice work when the storage getter throws.
export const browserDisplayName = createDisplayNameChoice(() => window.sessionStorage);

export const displayAttributionHealthSchema = z.object({
  capabilities: z.object({ displayAttribution: z.literal(1) }),
});
