// smarty-dev#799 L2: the person's private codes for the iPhone "Send to my Smarty" Shortcut, through the gateway's
// /me/share-tokens routes. The gateway owns the codes and who they belong to; this module only parses its answers and
// keeps the page's view of them. A new code's secret is shown once and kept only in memory until the page closes.
import { z } from 'zod';
import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';

const tokenSchema = z.object({ id: z.string().min(1), createdAt: z.string(), lastUsedAt: z.string().nullable().optional() });
const createdSchema = z.object({ id: z.string().min(1), token: z.string().min(1), createdAt: z.string() });

export type ShareToken = { id: string; createdAt: string; lastUsedAt: string | null };
export type CreatedShareToken = z.infer<typeof createdSchema>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class ShareTokenRequestError extends Error {
  constructor(readonly status: number) { super(`Share token request failed (${status})`); }
}

const API = '/api/me/share-tokens';
const json = { accept: 'application/json' };
const settingsSchema = z.object({ shareShortcutUrl: z.string().url().startsWith('https://').optional().catch(undefined) });

/** The operator's iCloud link to the Shortcut (settings key `shareShortcutUrl`); null until it exists. */
export async function loadShareShortcutUrl(fetcher: Fetcher = runtimeFetch): Promise<string | null> {
  try {
    const response = await fetcher('/api/config/settings', { credentials: 'include', headers: json });
    if (!response.ok) return null;
    return settingsSchema.parse(await response.json()).shareShortcutUrl ?? null;
  } catch {
    return null;
  }
}

export async function listShareTokens(fetcher: Fetcher = runtimeFetch): Promise<ShareToken[]> {
  const response = await fetcher(API, { credentials: 'include', headers: json });
  if (!response.ok) throw new ShareTokenRequestError(response.status);
  return z.array(tokenSchema).parse(await response.json()).map(token => ({ ...token, lastUsedAt: token.lastUsedAt ?? null }));
}

export async function createShareToken(fetcher: Fetcher = runtimeFetch): Promise<CreatedShareToken> {
  const response = await fetcher(API, { method: 'POST', credentials: 'include', headers: { ...json, 'content-type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new ShareTokenRequestError(response.status);
  return createdSchema.parse(await response.json());
}

async function removeShareToken(id: string, fetcher: Fetcher = runtimeFetch): Promise<void> {
  const response = await fetcher(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include', headers: json });
  // A code already gone is what the person asked for.
  if (!response.ok && response.status !== 404) throw new ShareTokenRequestError(response.status);
}

type ShareTokenList = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; tokens: ShareToken[] };

type ShareTokensStore = {
  list: ShareTokenList;
  /** The code just created: its secret is on screen until the page closes (`forgetCreated`), never stored. */
  created: CreatedShareToken | null;
  creating: boolean;
  createFailed: boolean;
  /** The id being removed, and the last id whose removal failed (its row stays). */
  removing: string | null;
  removeFailed: string | null;
  load: (fetcher?: Fetcher) => Promise<void>;
  create: (fetcher?: Fetcher) => Promise<void>;
  remove: (id: string, fetcher?: Fetcher) => Promise<boolean>;
  forgetCreated: () => void;
};

const initial: Pick<ShareTokensStore, 'list' | 'created' | 'creating' | 'createFailed' | 'removing' | 'removeFailed'> = {
  list: { state: 'loading' }, created: null, creating: false, createFailed: false, removing: null, removeFailed: null };

export const useShareTokensStore = create<ShareTokensStore>((set, get) => ({
  ...initial,
  load: async (fetcher) => {
    // A reload keeps the rows on screen; only the first load shows "Loading".
    if (get().list.state !== 'ready') set({ list: { state: 'loading' } });
    try {
      set({ list: { state: 'ready', tokens: await listShareTokens(fetcher) } });
    } catch {
      // Never an empty list on failure: the person sees that the list could not load.
      set({ list: { state: 'failed' } });
    }
  },
  create: async (fetcher) => {
    if (get().creating) return;
    set({ creating: true, createFailed: false });
    try {
      const created = await createShareToken(fetcher);
      const list = get().list;
      const row: ShareToken = { id: created.id, createdAt: created.createdAt, lastUsedAt: null };
      set({ created, creating: false,
        list: list.state === 'ready' ? { state: 'ready', tokens: [row, ...list.tokens.filter(token => token.id !== row.id)] } : list });
      if (list.state !== 'ready') void get().load(fetcher);
    } catch {
      set({ creating: false, createFailed: true });
    }
  },
  remove: async (id, fetcher) => {
    set({ removing: id, removeFailed: null });
    try {
      await removeShareToken(id, fetcher);
      const list = get().list;
      set({ removing: null, created: get().created?.id === id ? null : get().created,
        list: list.state === 'ready' ? { state: 'ready', tokens: list.tokens.filter(token => token.id !== id) } : list });
      return true;
    } catch {
      set({ removing: null, removeFailed: id });
      return false;
    }
  },
  forgetCreated: () => set({ created: null, createFailed: false, removeFailed: null }),
}));

/** Tests: back to a fresh page. */
export const resetShareTokensStore = () => useShareTokensStore.setState(initial);
