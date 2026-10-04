// Extension-host side of the project setup routes
// (`GET/PUT /api/projects/:projectId/config`): the webview cannot reach the
// filesystem, so it bridges here and this module reads and writes
// `~/.config/openchamber/projects/<projectId>.json` with the same rules the
// OpenChamber server applies (`project-setup.ts`). Server-owned keys in the
// file (`version`, `scheduledTasks`) and keys from newer builds survive a
// write untouched.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProjectSetupValidationError,
  mergeProjectSetup,
  personalProjectSetupOf,
  projectSetupPatchToStored,
  type ProjectSetupView,
  type SharedProjectConfigRead,
} from './project-setup';

export type ProjectSetupBridgeMessage = { id: string; type: string; payload?: unknown };
export type ProjectSetupBridgeResponse = { id: string; type: string; success: boolean; data?: unknown; error?: string };

export type ProjectSetupStore = {
  read: (projectId: string) => Promise<ProjectSetupView>;
  update: (projectId: string, patch: unknown) => Promise<ProjectSetupView>;
  updateShared: (projectId: string, patch: unknown) => Promise<ProjectSetupView>;
};

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

// Mirror of `projectConfigFileStemOf` in the server's
// `packages/web/server/lib/projects/project-id.js`; keep the two in sync. The
// file is named by the id while that fits a file name; a `path_<base64url>`
// id grows with the checkout path, so a long one maps to a fixed-length
// digest instead of a name the filesystem rejects (ENAMETOOLONG).
const MAX_PROJECT_CONFIG_FILE_STEM_LENGTH = 200;
const HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX = 'path_sha256_';

export const projectConfigFileStemOf = (projectId: string): string => {
  if (projectId.length <= MAX_PROJECT_CONFIG_FILE_STEM_LENGTH) return projectId;
  const digest = crypto.createHash('sha256').update(projectId, 'utf8').digest('hex');
  return `${HASHED_PROJECT_CONFIG_FILE_STEM_PREFIX}${digest}`;
};

/** The checkout a `path_<base64url>` id names, or `''` for ids of another form. */
export const projectPathFromId = (projectId: string): string => {
  if (!projectId.startsWith('path_')) return '';
  const encoded = projectId.slice('path_'.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return '';
  return Buffer.from(encoded, 'base64url').toString('utf8');
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeProjectId = (value: unknown): string => {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (!projectId) throw new ProjectSetupValidationError('projectId is required');
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new ProjectSetupValidationError('projectId contains unsupported characters');
  return projectId;
};

// The parsed document, or null when there is no file (one of `missingCodes`).
// Malformed JSON still throws; it is a broken file, not an empty one.
const readJsonDocumentIfPresent = async (filePath: string, missingCodes: string[]): Promise<Record<string, unknown> | null> => {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && missingCodes.includes(error.code)) return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  return isObjectRecord(parsed) ? parsed : {};
};

const writeJsonAtomic = async (filePath: string, text: string): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

/** A store over one projects directory; the default is the shared OpenChamber one. */
export const createProjectSetupStore = (
  projectsDir: string = path.join(os.homedir(), '.config', 'openchamber', 'projects'),
): ProjectSetupStore => {
  const filePathFor = (projectId: string): string => path.join(projectsDir, `${projectConfigFileStemOf(sanitizeProjectId(projectId))}.json`);
  // Where a build before the bounded name stored a long id's file, or null
  // when the id's own name is the current one. Read as a fallback and removed
  // once a write has moved its content to the bounded file, the same way the
  // server does it.
  const legacyFilePathFor = (projectId: string): string | null => {
    const safeProjectId = sanitizeProjectId(projectId);
    if (projectConfigFileStemOf(safeProjectId) === safeProjectId) return null;
    return path.join(projectsDir, `${safeProjectId}.json`);
  };
  const readPersonalDocument = async (projectId: string): Promise<Record<string, unknown>> => {
    const current = await readJsonDocumentIfPresent(filePathFor(projectId), ['ENOENT']);
    if (current) return current;
    const legacyPath = legacyFilePathFor(projectId);
    const legacy = legacyPath ? await readJsonDocumentIfPresent(legacyPath, ['ENOENT', 'ENAMETOOLONG']) : null;
    return legacy ?? {};
  };
  const writePersonalDocument = async (projectId: string, document: Record<string, unknown>): Promise<void> => {
    await writeJsonAtomic(filePathFor(projectId), JSON.stringify(document, null, 2));
    const legacyPath = legacyFilePathFor(projectId);
    if (legacyPath) await fs.promises.rm(legacyPath, { force: true }).catch(() => {});
  };
  // Writes to one file are chained so two quick saves from the webview cannot
  // interleave their read-modify-write.
  const writeChains = new Map<string, Promise<unknown>>();

  // Final fork policy (smarty-code#1325, item 3): shared repository config,
  // including command/starter discovery, is disabled before any checkout IO.
  // Report unavailable explicitly, never as an authoritative missing file.
  const disabledSharedConfig: SharedProjectConfigRead = { status: 'invalid', reason: 'shared-project-config-disabled' };

  const read = async (projectId: string): Promise<ProjectSetupView> =>
    mergeProjectSetup(personalProjectSetupOf(await readPersonalDocument(projectId)), disabledSharedConfig);

  const update = async (projectId: string, patch: unknown): Promise<ProjectSetupView> => {
    const filePath = filePathFor(projectId);
    const stored = projectSetupPatchToStored(patch);
    const previous = writeChains.get(filePath) ?? Promise.resolve();
    const next = previous.then(async () => {
      const existing = await readPersonalDocument(projectId);
      const merged: Record<string, unknown> = { ...existing, ...stored };
      for (const [key, value] of Object.entries(stored)) {
        if (value === undefined) delete merged[key];
      }
      await writePersonalDocument(projectId, merged);
      return mergeProjectSetup(personalProjectSetupOf(merged), disabledSharedConfig);
    });
    writeChains.set(filePath, next.catch(() => undefined));
    return next;
  };

  // Refuse before write chains or personal/checkout IO. No preference,
  // repository metadata or platform may re-enable shared editing.
  const updateShared = async (): Promise<ProjectSetupView> => {
    throw new Error('shared-project-config-writes-disabled');
  };

  return { read, update, updateShared };
};

export async function handleProjectSetupBridgeMessage(
  message: ProjectSetupBridgeMessage,
  store: ProjectSetupStore,
): Promise<ProjectSetupBridgeResponse | null> {
  const { id, type, payload } = message;
  if (type !== 'api:project-setup:get' && type !== 'api:project-setup:update' && type !== 'api:project-setup:update-shared') return null;

  try {
    const request = isObjectRecord(payload) ? payload : {};
    const projectId = sanitizeProjectId(request.projectId);
    const data = type === 'api:project-setup:get'
      ? await store.read(projectId)
      : type === 'api:project-setup:update'
        ? await store.update(projectId, request.patch)
        : await store.updateShared(projectId, request.patch);
    return { id, type, success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project config request failed';
    return { id, type, success: false, error: message };
  }
}

