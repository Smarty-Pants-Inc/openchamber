import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fsPromises from 'fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { migrateLegacyUserDirs } from './data-dir-migration.js';

const setup = async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-data-dir-'));
  const legacyRoot = path.join(root, 'legacy');
  const dataDir = path.join(root, 'custom');
  await fsPromises.mkdir(path.join(legacyRoot, 'projects'), { recursive: true });
  await fsPromises.writeFile(path.join(legacyRoot, 'projects', 'p.json'), '{"a":1}');
  await fsPromises.mkdir(path.join(legacyRoot, 'themes'), { recursive: true });
  await fsPromises.writeFile(path.join(legacyRoot, 'themes', 'custom.json'), '{"theme":1}');
  await fsPromises.mkdir(path.join(legacyRoot, 'speech-models'), { recursive: true });
  await fsPromises.writeFile(path.join(legacyRoot, 'speech-models', 'model.bin'), 'model');
  return { root, legacyRoot, dataDir, cleanup: () => fsPromises.rm(root, { recursive: true, force: true }) };
};

describe('migrateLegacyUserDirs', () => {
  it('copies the user folders once into a custom data dir and leaves the originals', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    try {
      const warnings = [];
      const moved = await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) });
      expect(moved).toEqual(['projects', 'themes', 'speech-models']);
      expect(warnings).toEqual([]);
      expect(await fsPromises.readFile(path.join(dataDir, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      // The default instance keeps its own copy: a second instance must not strip it.
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      expect(await fsPromises.readFile(path.join(dataDir, 'themes', 'custom.json'), 'utf8')).toBe('{"theme":1}');
      expect(await fsPromises.readFile(path.join(dataDir, 'speech-models', 'model.bin'), 'utf8')).toBe('model');
      expect(await fsPromises.readFile(path.join(legacyRoot, 'themes', 'custom.json'), 'utf8')).toBe('{"theme":1}');
      expect(await fsPromises.readFile(path.join(legacyRoot, 'speech-models', 'model.bin'), 'utf8')).toBe('model');
      // A second start copies nothing more.
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('never merges into a folder that already exists in the data dir', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    try {
      await fsPromises.mkdir(path.join(dataDir, 'projects'), { recursive: true });
      await fsPromises.writeFile(path.join(dataDir, 'projects', 'q.json'), '{}');
      const moved = await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot });
      expect(moved).toEqual(['themes', 'speech-models']);
      expect(await fsPromises.readdir(path.join(dataDir, 'projects'))).toEqual(['q.json']);
      expect(await fsPromises.readdir(path.join(legacyRoot, 'projects'))).toEqual(['p.json']);
    } finally {
      await cleanup();
    }
  });

  it('preserves a completed concurrent migration and its newer destination data', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const bothChecked = Promise.withResolvers();
    const winnerFinished = Promise.withResolvers();
    const projectsDir = path.join(dataDir, 'projects');
    const warnings = [];
    let checks = 0;
    let losingCopies = 0;
    // Both calls really observe ENOENT before either can publish a destination.
    const access = async (target) => {
      try {
        return await fsPromises.access(target);
      } catch (error) {
        if (target === projectsDir) {
          checks += 1;
          if (checks === 2) bothChecked.resolve();
          await bothChecked.promise;
        }
        throw error;
      }
    };
    const losingFs = {
      ...fsPromises,
      access,
      mkdir: async (target, options) => {
        if (target === dataDir) await winnerFinished.promise;
        return fsPromises.mkdir(target, options);
      },
      cp: async (...args) => {
        losingCopies += 1;
        return fsPromises.cp(...args);
      },
    };
    const losing = migrateLegacyUserDirs({ fsPromises: losingFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) });
    try {
      const winning = await migrateLegacyUserDirs({ fsPromises: { ...fsPromises, access }, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) });
      expect(winning).toEqual(['projects', 'themes', 'speech-models']);
      await fsPromises.writeFile(path.join(projectsDir, 'p.json'), 'newer project data');
      await fsPromises.writeFile(path.join(projectsDir, 'new.json'), 'new destination file');
      winnerFinished.resolve();
      expect(await losing).toEqual([]);
      expect(await fsPromises.readFile(path.join(projectsDir, 'p.json'), 'utf8')).toBe('newer project data');
      expect(await fsPromises.readFile(path.join(projectsDir, 'new.json'), 'utf8')).toBe('new destination file');
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      expect(await fsPromises.readFile(path.join(dataDir, 'themes', 'custom.json'), 'utf8')).toBe('{"theme":1}');
      expect(await fsPromises.readFile(path.join(dataDir, 'speech-models', 'model.bin'), 'utf8')).toBe('model');
      expect(losingCopies).toBe(0);
      expect(warnings).toEqual([]);
    } finally {
      winnerFinished.resolve();
      await losing;
      await cleanup();
    }
  });

  it('skips a foreign final directory created after the existence check without copying or deleting it', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const warnings = [];
    const copied = [];
    const projectsDir = path.join(dataDir, 'projects');
    let foreignCreated = false;
    const racedFs = {
      ...fsPromises,
      mkdir: async (target, options) => {
        const result = await fsPromises.mkdir(target, options);
        if (target === dataDir && !foreignCreated) {
          foreignCreated = true;
          await fsPromises.mkdir(projectsDir);
          await fsPromises.writeFile(path.join(projectsDir, 'p.json'), 'foreign project data');
          await fsPromises.writeFile(path.join(projectsDir, 'new.json'), 'foreign new file');
        }
        return result;
      },
      cp: async (from, to, options) => {
        copied.push(path.basename(path.dirname(from)));
        return fsPromises.cp(from, to, options);
      },
    };
    try {
      expect(await migrateLegacyUserDirs({ fsPromises: racedFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) })).toEqual(['themes', 'speech-models']);
      expect(await fsPromises.readFile(path.join(projectsDir, 'p.json'), 'utf8')).toBe('foreign project data');
      expect(await fsPromises.readFile(path.join(projectsDir, 'new.json'), 'utf8')).toBe('foreign new file');
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      expect(copied).toEqual(['themes', 'speech-models']);
      expect(warnings).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('keeps partial and newer destination bytes on copy failure, warns and continues startup', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const warnings = [];
    const projectsDir = path.join(dataDir, 'projects');
    const failingFs = {
      ...fsPromises,
      cp: async (from, to, options) => {
        if (to === projectsDir || path.dirname(to) === projectsDir) {
          // A real partial copy followed by another instance writing new data.
          await fsPromises.mkdir(projectsDir, { recursive: true });
          await fsPromises.cp(path.join(legacyRoot, 'projects', 'p.json'), path.join(projectsDir, 'p.json'), options);
          await fsPromises.writeFile(path.join(projectsDir, 'new.json'), 'new destination file');
          // The real non-clobbering copy now fails on the already copied file.
        }
        return fsPromises.cp(from, to, options);
      },
    };
    try {
      const moved = await migrateLegacyUserDirs({ fsPromises: failingFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) });
      expect(moved).toEqual(['themes', 'speech-models']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Failed to copy ${path.join(legacyRoot, 'projects')} to ${projectsDir}:`);
      expect(await fsPromises.readFile(path.join(projectsDir, 'p.json'), 'utf8')).toBe('{"a":1}');
      expect(await fsPromises.readFile(path.join(projectsDir, 'new.json'), 'utf8')).toBe('new destination file');
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      expect(warnings[0]).toContain('any partial destination is retained and will be skipped on later starts');
      // Later starts leave the retained destination alone, even after failure.
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual([]);
      expect(await fsPromises.readFile(path.join(projectsDir, 'new.json'), 'utf8')).toBe('new destination file');
    } finally {
      await cleanup();
    }
  });

  it('warns on destination creation failure without blocking unrelated entries', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const warnings = [];
    const projectsDir = path.join(dataDir, 'projects');
    const failingFs = {
      ...fsPromises,
      mkdir: async (target, options) => {
        if (target === projectsDir) throw new Error('destination creation denied');
        return fsPromises.mkdir(target, options);
      },
    };
    try {
      expect(await migrateLegacyUserDirs({ fsPromises: failingFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) })).toEqual(['themes', 'speech-models']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('destination creation denied');
      expect(await fsPromises.readdir(dataDir)).toEqual(['speech-models', 'themes']);
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
    } finally {
      await cleanup();
    }
  });

  it('does not create destinations for missing legacy folders', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    try {
      await fsPromises.rm(path.join(legacyRoot, 'speech-models'), { recursive: true });
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual(['projects', 'themes']);
      expect(await fsPromises.readdir(dataDir)).toEqual(['projects', 'themes']);
    } finally {
      await cleanup();
    }
  });

  it('admits only one copy per entry across two native processes', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const moduleUrl = new URL('./data-dir-migration.js', import.meta.url).href;
    const script = `
      import fsPromises from 'node:fs/promises';
      import path from 'node:path';
      const { migrateLegacyUserDirs } = await import(process.argv[1]);
      const warnings = [];
      const moved = await migrateLegacyUserDirs({
        fsPromises, path, legacyRoot: process.argv[2], dataDir: process.argv[3],
        warn: (message) => warnings.push(message),
      });
      console.log(JSON.stringify({ moved, warnings }));
    `;
    try {
      const results = await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, [
        '--input-type=module', '-e', script, moduleUrl, legacyRoot, dataDir,
      ], { timeout: 10_000 })));
      const receipts = results.map(({ stdout }) => JSON.parse(stdout));
      expect(receipts.flatMap(({ moved }) => moved).sort()).toEqual(['projects', 'speech-models', 'themes']);
      expect(receipts.flatMap(({ warnings }) => warnings)).toEqual([]);
      for (const [entry, filename, content] of [
        ['projects', 'p.json', '{"a":1}'],
        ['themes', 'custom.json', '{"theme":1}'],
        ['speech-models', 'model.bin', 'model'],
      ]) {
        expect(await fsPromises.readFile(path.join(dataDir, entry, filename), 'utf8')).toBe(content);
        expect(await fsPromises.readFile(path.join(legacyRoot, entry, filename), 'utf8')).toBe(content);
      }
    } finally {
      await cleanup();
    }
  });

  it('copies empty folders and nested contents into the owned destination', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    try {
      await fsPromises.rm(path.join(legacyRoot, 'themes', 'custom.json'));
      await fsPromises.mkdir(path.join(legacyRoot, 'projects', 'nested'));
      await fsPromises.writeFile(path.join(legacyRoot, 'projects', 'nested', 'p.json'), 'nested project');
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual(['projects', 'themes', 'speech-models']);
      expect(await fsPromises.readdir(path.join(dataDir, 'themes'))).toEqual([]);
      expect(await fsPromises.readFile(path.join(dataDir, 'projects', 'nested', 'p.json'), 'utf8')).toBe('nested project');
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'nested', 'p.json'), 'utf8')).toBe('nested project');
    } finally {
      await cleanup();
    }
  });

  it('is a no-op when the data dir is the default root', async () => {
    const { legacyRoot, cleanup } = await setup();
    try {
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir: legacyRoot, legacyRoot })).toEqual([]);
      expect(await fsPromises.readdir(path.join(legacyRoot, 'projects'))).toEqual(['p.json']);
    } finally {
      await cleanup();
    }
  });
});
