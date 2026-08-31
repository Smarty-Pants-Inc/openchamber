import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BtwPanelState } from './useBtwPanelState';

const messageRecords = [{
  info: { id: 'fork-tail', role: 'user', time: { created: 1 } },
  parts: [],
}];
type MessageLoadStateFixture = {
  status: 'ready' | 'error';
  loadingKind: null;
  error: Error | null;
  resolved: boolean;
  limit: number;
  cursor: undefined;
  complete: boolean;
  generation: number;
  newestPageGeneration: number | null;
  updatedAt: number;
};

let messageLoadState: MessageLoadStateFixture = {
  status: 'ready',
  loadingKind: null,
  error: null,
  resolved: true,
  limit: 50,
  cursor: undefined,
  complete: false,
  generation: 7,
  newestPageGeneration: 7,
  updatedAt: 1,
};
const filterCalls: boolean[] = [];
const filterBtwTailMessages = (
  records: typeof messageRecords,
  boundaryMessageID: string | null,
  newestPageResolved = false,
) => {
  filterCalls.push(newestPageResolved);
  const boundaryIndex = boundaryMessageID
    ? records.findIndex((record) => record.info.id === boundaryMessageID)
    : -1;
  if (boundaryIndex >= 0) return records.slice(boundaryIndex + 1);
  return newestPageResolved ? records : [];
};

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
mock.module('@/stores/useBtwStore', () => ({
  useBtwStore: Object.assign(() => undefined, {
    getState: () => ({ setPanelState: () => undefined }),
  }),
}));
mock.module('@/sync/use-sync', () => ({
  useSync: () => ({ ensureSessionRenderable: () => Promise.resolve() }),
}));
mock.module('@/sync/sync-context', () => ({
  useSessionMessageRecords: () => messageRecords,
  useSessionMessageLoadState: () => messageLoadState,
  useSessionMessageLoader: () => ({ refreshTail: () => Promise.resolve(7) }),
  useSessionRenderable: () => true,
  useSessionStatus: () => ({ type: 'idle' }),
  useScopedBlockingPermissions: () => [],
  useScopedBlockingQuestions: () => [],
}));
type StreamingSelection = string | { phase: 'streaming' } | null;

mock.module('@/sync/streaming', () => ({
  useStreamingStore: (selector: (state: {
    streamingMessageIds: Map<string, string>;
    messageStreamStates: Map<string, { phase: 'streaming' }>;
  }) => StreamingSelection): StreamingSelection => selector({ streamingMessageIds: new Map(), messageStreamStates: new Map() }),
}));
mock.module('@/components/ui/ScrollShadow', () => ({
  ScrollShadow: React.forwardRef<HTMLDivElement, React.PropsWithChildren>(({ children }, ref) => (
    <div ref={ref}>{children}</div>
  )),
}));
mock.module('@/lib/btw', () => ({
  destroyBtwSession: () => Promise.resolve(true),
  filterBtwTailMessages,
  promoteBtwSession: () => Promise.resolve(),
}));
mock.module('../ChatSurfaceContext', () => ({
  ChatSurfaceProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
mock.module('../useMobileAutocompleteMaxHeight', () => ({ useMobileAutocompleteMaxHeight: () => undefined }));
mock.module('../ChatMessage', () => ({
  default: ({ message }: { message: { info: { id: string } } }) => <div>{message.info.id}</div>,
}));
mock.module('../PermissionCard', () => ({ PermissionCard: () => null }));
mock.module('../QuestionCard', () => ({ QuestionCard: () => null }));

// Dynamic import follows the isolated panel module mocks above.
const { BtwPanel } = await import('./BtwPanel');

const panel: BtwPanelState = {
  btwSessionId: 'fork-1',
  // SAFETY: this isolated rendering fixture only reads the session id and title.
  btwSession: { id: 'fork-1', title: 'BTW' } as BtwPanelState['btwSession'],
  btwDirectory: '/project',
  boundaryMessageID: 'missing-boundary',
  collapsed: false,
  creating: false,
};

describe('BtwPanel newest-page authority', () => {
  beforeEach(() => {
    filterCalls.length = 0;
    messageLoadState = {
      status: 'ready',
      loadingKind: null,
      error: null,
      resolved: true,
      limit: 50,
      cursor: undefined,
      complete: false,
      generation: 7,
      newestPageGeneration: 7,
      updatedAt: 1,
    };
  });

  test('keeps a successful tail refresh authoritative after collapse and expanded-panel remount', () => {
    const initialMarkup = renderToStaticMarkup(<BtwPanel parentSessionId="parent-1" panel={panel} />);
    expect(initialMarkup).toContain('fork-tail');

    // The loader survives collapse; a later refresh failure must not erase its
    // newest-page generation before the expanded panel mounts again.
    messageLoadState = { ...messageLoadState, status: 'error', error: new Error('refresh failed') };
    const remountedMarkup = renderToStaticMarkup(<BtwPanel parentSessionId="parent-1" panel={panel} />);

    expect(remountedMarkup).toContain('fork-tail');
    expect(filterCalls).toEqual([true, true]);
  });
});
