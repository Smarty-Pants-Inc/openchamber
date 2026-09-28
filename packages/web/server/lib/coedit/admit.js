import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveWorkspacePathFromContext } from '../fs/routes.js';
import { inside } from './safe-file.js';

/**
 * The Files view's project admission for a co-edit room: the explicit project `directory` (never the saved last one)
 * and a `file` inside it, resolved like a Files view write. Returns the canonical project root and file; throws on
 * anything else (no project, outside it, a managed root such as the chats root, a missing file, not a regular file).
 */
export function createCoeditAdmission({ resolveProjectDirectory, normalizeDirectoryPath, managedRoots = [] }) {
  return async (_req, { directory, path: filePath }) => {
    if (!directory || !filePath) throw new Error('A co-edit room needs a project and a file');
    const request = { query: { directory }, get: () => null };
    const resolved = await resolveWorkspacePathFromContext({
      req: request, targetPath: filePath, resolveProjectDirectory, path, os, normalizeDirectoryPath, managedRoots,
    });
    if (!resolved.ok) throw new Error(resolved.error || 'Outside the project');
    const root = resolved.canonicalBase ?? await fs.promises.realpath(resolved.base);
    const managed = await Promise.all(managedRoots.map((dir) => fs.promises.realpath(dir).catch(() => path.resolve(dir))));
    if (managed.some((dir) => inside(dir, root))) throw new Error('Co-editing is for project files');
    const file = await fs.promises.realpath(resolved.resolved);
    if (!inside(root, file) || file === root) throw new Error('Outside the project');
    if (!(await fs.promises.stat(file)).isFile()) throw new Error('Not a file');
    return { root, file };
  };
}
