import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PermissionRequest } from '@/types/permission';
import { getVisiblePermissionPatterns } from './permissionCardPatterns';

mock.module('@/lib/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (state: { currentSessionId: string | null }) => string | null) => selector({ currentSessionId: null }),
}));
mock.module('@/sync/sync-context', () => ({ useSessions: () => [] }));
mock.module('@/sync/session-actions', () => ({ respondToPermission: async () => undefined }));
mock.module('@/components/code/WorkerHighlightedCode', () => ({
  WorkerHighlightedCode: ({ code }: { code: string }) => React.createElement('pre', null, code),
}));
mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('./DiffPreview', () => ({ DiffPreview: () => null, WritePreview: () => null }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/shortcuts', () => ({ formatShortcutForDisplay: (shortcut: string) => shortcut }));

// Static import would load PermissionCard before these module mocks apply.
const { PermissionCard } = await import('./PermissionCard');

const renderPermissionCard = (always: string[]) => {
  const permission: PermissionRequest = {
    id: 'permission-1',
    sessionID: 'session-1',
    permission: 'bash',
    patterns: [],
    metadata: {},
    always,
  };
  return renderToStaticMarkup(React.createElement(PermissionCard, { permission }));
};

describe('getVisiblePermissionPatterns', () => {
  test('omits a pattern already rendered as the bash command', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns([command], command)).toEqual([]);
  });

  test('preserves distinct permission patterns', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns(['bunx eslint *', command], command)).toEqual(['bunx eslint *']);
  });
});

describe('PermissionCard', () => {
  test('hides Always Allow when no always pattern is available', () => {
    const markup = renderPermissionCard([]);

    expect(markup.match(/<button/g) ?? []).toHaveLength(2);
    expect(markup).not.toContain('Always Allow');
  });

  test('keeps the pattern-specific always action', () => {
    const markup = renderPermissionCard(['bun test *']);

    expect(markup).toContain('Always: bun test *');
  });
});
