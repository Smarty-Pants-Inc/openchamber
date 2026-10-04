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
  it.skipIf(process.platform === 'win32').each([false, true])('keeps destinations private before every child copy with an existing data root: %s', async (existingRoot) => {
    const { root, legacyRoot, dataDir, cleanup } = await setup();
    const warnings = [];
    const beforeCopies = [];
    try {
      expect(process.umask()).toBe(0o022);
      // A traversable custom parent must not hide a permissive destination.
      await fsPromises.chmod(root, 0o755);
      for (const entry of ['projects', 'themes', 'speech-models']) {
        await fsPromises.chmod(path.join(legacyRoot, entry), 0o700);
      }
      await fsPromises.chmod(path.join(legacyRoot, 'projects', 'p.json'), 0o644);
      if (existingRoot) await fsPromises.mkdir(dataDir, { mode: 0o755 });
      const inspectingFs = {
        ...fsPromises,
        cp: async (from, to, options) => {
          beforeCopies.push({
            rootMode: (await fsPromises.stat(dataDir)).mode & 0o777,
            destinationMode: (await fsPromises.stat(path.dirname(to))).mode & 0o777,
          });
          return fsPromises.cp(from, to, options);
        },
      };
      expect(await migrateLegacyUserDirs({ fsPromises: inspectingFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) })).toEqual(['projects', 'themes', 'speech-models']);
      expect(warnings).toEqual([]);
      expect(beforeCopies).toEqual(Array.from({ length: 3 }, () => ({ rootMode: existingRoot ? 0o755 : 0o700, destinationMode: 0o700 })));
      expect((await fsPromises.stat(dataDir)).mode & 0o777).toBe(existingRoot ? 0o755 : 0o700);
      for (const entry of ['projects', 'themes', 'speech-models']) {
        expect((await fsPromises.stat(path.join(dataDir, entry))).mode & 0o777).toBe(0o700);
        expect((await fsPromises.stat(path.join(legacyRoot, entry))).mode & 0o777).toBe(0o700);
      }
      expect((await fsPromises.stat(path.join(dataDir, 'projects', 'p.json'))).mode & 0o777).toBe(0o644);
      expect((await fsPromises.stat(path.join(legacyRoot, 'projects', 'p.json'))).mode & 0o777).toBe(0o644);
      expect(await fsPromises.readFile(path.join(dataDir, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32').each([0o500, 0o300])('retains stricter source owner bits on success or unreadable-source failure: %s', async (sourceMode) => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const sourceDir = path.join(legacyRoot, 'projects');
    const destinationDir = path.join(dataDir, 'projects');
    const warnings = [];
    const beforeCopies = [];
    try {
      await fsPromises.chmod(sourceDir, sourceMode);
      const inspectingFs = {
        ...fsPromises,
        cp: async (from, to, options) => {
          if (path.dirname(to) === destinationDir) beforeCopies.push((await fsPromises.stat(destinationDir)).mode & 0o777);
          return fsPromises.cp(from, to, options);
        },
      };
      const moved = await migrateLegacyUserDirs({ fsPromises: inspectingFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) });
      // Root can enumerate 0300; an ordinary POSIX owner cannot.
      const readable = sourceMode === 0o500 || process.getuid() === 0;
      expect(moved).toEqual(readable ? ['projects', 'themes', 'speech-models'] : ['themes', 'speech-models']);
      expect(beforeCopies).toEqual(readable ? [0o700] : []);
      expect(warnings).toHaveLength(readable ? 0 : 1);
      if (!readable) expect(warnings[0]).toContain('EACCES');
      expect((await fsPromises.stat(sourceDir)).mode & 0o777).toBe(sourceMode);
      expect((await fsPromises.stat(destinationDir)).mode & 0o777).toBe(sourceMode);
      expect(await fsPromises.readFile(path.join(dataDir, 'themes', 'custom.json'), 'utf8')).toBe('{"theme":1}');
      expect(await fsPromises.readFile(path.join(dataDir, 'speech-models', 'model.bin'), 'utf8')).toBe('model');
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual([]);
    } finally {
      // Only these fixture directories need write/read access for cleanup.
      await fsPromises.chmod(sourceDir, 0o700);
      await fsPromises.chmod(destinationDir, 0o700).catch(() => {});
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('retains private partial data and source owner restrictions after a copy fails', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const sourceDir = path.join(legacyRoot, 'projects');
    const destinationDir = path.join(dataDir, 'projects');
    const warnings = [];
    const beforeCopies = [];
    try {
      await fsPromises.chmod(sourceDir, 0o500);
      const failingFs = {
        ...fsPromises,
        cp: async (from, to, options) => {
          if (path.dirname(to) === destinationDir) {
            beforeCopies.push((await fsPromises.stat(destinationDir)).mode & 0o777);
            await fsPromises.cp(from, to, options);
            await fsPromises.writeFile(path.join(destinationDir, 'new.json'), 'new destination data');
            throw new Error('copy failed after partial data');
          }
          return fsPromises.cp(from, to, options);
        },
      };
      expect(await migrateLegacyUserDirs({ fsPromises: failingFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) })).toEqual(['themes', 'speech-models']);
      expect(beforeCopies).toEqual([0o700]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('copy failed after partial data');
      expect((await fsPromises.stat(destinationDir)).mode & 0o777).toBe(0o500);
      expect(await fsPromises.readFile(path.join(destinationDir, 'p.json'), 'utf8')).toBe('{"a":1}');
      expect(await fsPromises.readFile(path.join(destinationDir, 'new.json'), 'utf8')).toBe('new destination data');
      expect((await fsPromises.stat(sourceDir)).mode & 0o777).toBe(0o500);
      expect(await migrateLegacyUserDirs({ fsPromises, path, dataDir, legacyRoot })).toEqual([]);
    } finally {
      await fsPromises.chmod(sourceDir, 0o700);
      await fsPromises.chmod(destinationDir, 0o700).catch(() => {});
      await cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('does not mutate existing destination permissions or contents', async () => {
    const { legacyRoot, dataDir, cleanup } = await setup();
    const destinationDir = path.join(dataDir, 'projects');
    try {
      await fsPromises.mkdir(destinationDir, { recursive: true });
      await fsPromises.chmod(dataDir, 0o755);
      await fsPromises.chmod(destinationDir, 0o755);
      await fsPromises.writeFile(path.join(destinationDir, 'new.json'), 'existing destination data');
      const mutations = [];
      const existingFs = {
        ...fsPromises,
        mkdir: async () => { mutations.push('mkdir'); throw new Error('must not create'); },
        cp: async () => { mutations.push('cp'); throw new Error('must not copy'); },
        chmod: async () => { mutations.push('chmod'); throw new Error('must not chmod'); },
        rm: async () => { mutations.push('rm'); throw new Error('must not delete'); },
      };
      expect(await migrateLegacyUserDirs({ fsPromises: existingFs, path, dataDir, legacyRoot, entries: ['projects'] })).toEqual([]);
      expect(mutations).toEqual([]);
      expect((await fsPromises.stat(dataDir)).mode & 0o777).toBe(0o755);
      expect((await fsPromises.stat(destinationDir)).mode & 0o777).toBe(0o755);
      expect(await fsPromises.readdir(destinationDir)).toEqual(['new.json']);
      expect(await fsPromises.readFile(path.join(destinationDir, 'new.json'), 'utf8')).toBe('existing destination data');
    } finally {
      await cleanup();
    }
  });

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
    const losingMutations = [];
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
      chmod: async (...args) => {
        losingMutations.push('chmod');
        return fsPromises.chmod(...args);
      },
      rm: async (...args) => {
        losingMutations.push('rm');
        return fsPromises.rm(...args);
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
      expect(losingMutations).toEqual([]);
      if (process.platform !== 'win32') expect((await fsPromises.stat(projectsDir)).mode & 0o777).toBe(0o700);
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
    const forbiddenMutations = [];
    const racedFs = {
      ...fsPromises,
      mkdir: async (target, options) => {
        const result = await fsPromises.mkdir(target, options);
        if (target === dataDir && !foreignCreated) {
          foreignCreated = true;
          await fsPromises.mkdir(projectsDir, { mode: 0o755 });
          await fsPromises.writeFile(path.join(projectsDir, 'p.json'), 'foreign project data');
          await fsPromises.writeFile(path.join(projectsDir, 'new.json'), 'foreign new file');
        }
        return result;
      },
      cp: async (from, to, options) => {
        copied.push(path.basename(path.dirname(from)));
        return fsPromises.cp(from, to, options);
      },
      chmod: async (...args) => {
        forbiddenMutations.push('chmod');
        return fsPromises.chmod(...args);
      },
      rm: async (...args) => {
        forbiddenMutations.push('rm');
        return fsPromises.rm(...args);
      },
    };
    try {
      expect(await migrateLegacyUserDirs({ fsPromises: racedFs, path, dataDir, legacyRoot, warn: (message) => warnings.push(message) })).toEqual(['themes', 'speech-models']);
      expect(await fsPromises.readFile(path.join(projectsDir, 'p.json'), 'utf8')).toBe('foreign project data');
      expect(await fsPromises.readFile(path.join(projectsDir, 'new.json'), 'utf8')).toBe('foreign new file');
      expect(await fsPromises.readFile(path.join(legacyRoot, 'projects', 'p.json'), 'utf8')).toBe('{"a":1}');
      expect(copied).toEqual(['themes', 'speech-models']);
      expect(forbiddenMutations).toEqual([]);
      if (process.platform !== 'win32') expect((await fsPromises.stat(projectsDir)).mode & 0o777).toBe(0o755);
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
