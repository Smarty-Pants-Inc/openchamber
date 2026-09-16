import fs from 'node:fs';
import path from 'node:path';

const VERSION = 2;
const LEGACY_GUARD = JSON.stringify({ version: VERSION, sessions: {} });

// Separate custody from the v1 filename: old readers ignore version fields.
// They see an empty guard, never an unknown item, and cannot overwrite v2.
export function createQueuePersistence(dataDir, parseQueues) {
  const file = path.join(dataDir, 'message-queue-v2.json');
  const legacy = path.join(dataDir, 'message-queue.json');

  const read = async (filename) => {
    try { return await fs.promises.readFile(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };

  const writeBytes = async (filename, bytes) => {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const temp = `${filename}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(temp, bytes, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(temp, filename);
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
  };

  const write = (queues, revision) => writeBytes(file, JSON.stringify({
    version: VERSION, revision, sessions: Object.fromEntries(queues),
  }));

  const parse = (bytes, version) => parseQueues(JSON.parse(bytes), version);

  const load = async () => {
    const bytes = await read(file);
    const oldBytes = await read(legacy);
    if (bytes !== null) {
      // An old process ran after cutover. Do not merge or restore its intents
      // over newer effects. The operator must reconcile both retained files.
      if (oldBytes !== LEGACY_GUARD) throw new Error('Legacy queue changed after migration; reconciliation required');
      return parse(bytes, VERSION);
    }
    let stored = { queues: new Map(), revision: 0 };
    if (oldBytes !== null) {
      try { JSON.parse(oldBytes); }
      catch {
        await fs.promises.rename(legacy, `${legacy}.corrupt-${Date.now()}`);
        return stored;
      }
      stored = parse(oldBytes, 1);
      const backup = `${legacy}.v1-backup`;
      try { await fs.promises.writeFile(backup, oldBytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST' || await read(backup) !== oldBytes) throw error;
      }
      await write(stored.queues, stored.revision);
      await writeBytes(legacy, LEGACY_GUARD);
    }
    return stored;
  };

  return {
    load,
    // The guard precedes first v2 admission. A crash here cannot lose an ACKed
    // item. A crash during migration fails closed on next load, with both files.
    write: async (queues, revision) => {
      const guard = await read(legacy);
      if (guard === null) await writeBytes(legacy, LEGACY_GUARD);
      else if (guard !== LEGACY_GUARD) throw new Error('Legacy queue changed after migration; reconciliation required');
      await write(queues, revision);
    },
  };
}
