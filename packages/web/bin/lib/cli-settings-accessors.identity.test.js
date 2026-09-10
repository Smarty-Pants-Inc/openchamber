import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createSettingsAccessors } from './cli-settings-accessors.js';
import { createRelayIdentityRuntime } from '../../server/lib/relay/identity.js';

const withTempDir = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-settings-identity-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const makeAccessors = (dir, fsPromises = fs.promises) => createSettingsAccessors({
  fsPromises, path, dataDir: dir, settingsFileName: 'settings.json',
});

const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

describe('CLI relay identity settings adapter', () => {
  it('creates one durable relay identity for concurrent callers and preserves projects', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      const projects = [{ id: 'project-1', path: '/synthetic/project', label: 'Keep' }];
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ projects }));

      const identities = await Promise.all(
        Array.from({ length: 6 }, () => createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity()),
      );
      const stored = readSettings(dir);
      const durable = await createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity();

      expect(new Set(identities.map((identity) => identity.serverId))).toEqual(new Set([durable.serverId]));
      expect(identities.every((identity) => identity.hostEncPubJwk.x === stored.relayEncryptionKey.publicJwk.x)).toBe(true);
      expect(stored.projects).toEqual(projects);
      expect(stored.relaySigningKey).toBeTruthy();
      expect(stored.relayEncryptionKey).toBeTruthy();
    });
  });

  it.each([false, true])('keeps existing keys with encryption present=%s', async (withEncryption) => {
    await withTempDir(async (dir) => {
      const signing = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const encryption = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
      const relaySigningKey = { privateJwk: signing.privateKey.export({ format: 'jwk' }), publicJwk: signing.publicKey.export({ format: 'jwk' }) };
      const relayEncryptionKey = {
        privateJwk: await crypto.webcrypto.subtle.exportKey('jwk', encryption.privateKey),
        publicJwk: await crypto.webcrypto.subtle.exportKey('jwk', encryption.publicKey),
      };
      const settings = { relaySigningKey };
      if (withEncryption) settings.relayEncryptionKey = relayEncryptionKey;
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));

      await createRelayIdentityRuntime({ crypto, ...makeAccessors(dir) }).getRelayIdentity();
      expect(readSettings(dir)).toMatchObject(settings);
      expect(readSettings(dir).relayEncryptionKey).toBeTruthy();
    });
  });

  it.each(['{"relaySigningKey": {"unfinished', '[]', 'null'])('does not generate or overwrite invalid settings payload %s', async (payload) => {
    await withTempDir(async (dir) => {
      const settingsPath = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsPath, payload);

      await expect(createRelayIdentityRuntime({ crypto, ...makeAccessors(dir) }).getRelayIdentity()).rejects.toThrow();
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(payload);
    });
  });

  it('skips an unchanged callback result', async () => {
    await withTempDir(async (dir) => {
      let writes = 0;
      const fsPromises = { ...fs.promises, writeFile: async (...args) => {
        writes += 1;
        return fs.promises.writeFile(...args);
      } };
      const accessors = makeAccessors(dir, fsPromises);
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ projects: [] }));

      await accessors.writeSettingsToDisk((current) => current);
      expect(writes).toBe(0);
    });
  });

  it('recovers after a failed callback write and supports explicit object recovery', async () => {
    await withTempDir(async (dir) => {
      let failWrite = true;
      const fsPromises = {
        ...fs.promises,
        writeFile: async (...args) => {
          if (failWrite) {
            failWrite = false;
            throw new Error('synthetic disk failure');
          }
          return fs.promises.writeFile(...args);
        },
      };
      const accessors = makeAccessors(dir, fsPromises);
      const settingsPath = path.join(dir, 'settings.json');

      await expect(createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity()).rejects.toThrow('synthetic disk failure');
      expect((await createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity()).serverId).toBeTruthy();

      fs.writeFileSync(settingsPath, 'null');
      await accessors.writeSettingsToDisk({ projects: [{ id: 'recovered', path: '/synthetic/recovered' }] });
      await accessors.writeSettingsToDisk((current) => current);
      expect(await accessors.readSettingsStrict()).toEqual({ projects: [{ id: 'recovered', path: '/synthetic/recovered' }] });
    });
  });
});
