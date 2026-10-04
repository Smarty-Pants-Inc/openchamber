import { expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { autoRespondsPermission, type PermissionAutoAcceptMap } from './permissionAutoAccept';

const root: Session = { id: 'root', slug: 'root', projectID: 'project', directory: '/project', title: 'Root', version: '1', time: { created: 1, updated: 1 } };
const child: Session = { ...root, id: 'child', parentID: 'root' };
const policies: PermissionAutoAcceptMap[] = [{}, { root: true }, { root: false }, { root: true, child: true }, { root: true, child: false }];
for (const autoAccept of policies) {
  test(`no stored or inherited policy grants automatic reply authority: ${JSON.stringify(autoAccept)}`, () => {
    const snapshot = JSON.stringify(autoAccept);
    for (const sessionID of ['root', 'child', 'unknown']) {
      expect(autoRespondsPermission({ autoAccept, sessions: [root, child], sessionID })).toBe(false);
      expect(autoRespondsPermission({ autoAccept, sessions: [], sessionById: new Map([[root.id, root], [child.id, child]]), sessionID })).toBe(false);
    }
    expect(JSON.stringify(autoAccept)).toBe(snapshot);
  });
}
