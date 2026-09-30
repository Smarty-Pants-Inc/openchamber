import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { testUtils } from 'better-auth/plugins';
import { createHumanAuth } from './human-auth.js';

const config = { baseURL: 'http://localhost:43210', secret: 'fixture-only-secret-at-least-thirty-two-characters',
  googleClientId: 'fixture-client', googleClientSecret: 'fixture-secret', allowedDomains: ['example.test'] };
const field = { type: 'string', required: false, input: false, returned: false };

test('installed Better Auth supports additive private string migration, fresh adapter roundtrip and rollback preservation', async () => {
  const database = new DatabaseSync(':memory:');
  const human = await createHumanAuth({ ...config, database });
  const upgradeDatabase = new DatabaseSync(':memory:');
  try {
    const column = database.prepare('PRAGMA table_info(user)').all().find(field => field.name === 'sidebarPreferences');
    assert.equal(column.notnull, 0);
    assert.equal(column.dflt_value, null);
    const oldOptions = { ...human.auth.options, database: upgradeDatabase, user: { ...human.auth.options.user,
      validateUserInfo: undefined, additionalFields: { retainedField: field } }, plugins: [testUtils()] };
    await (await getMigrations(oldOptions)).runMigrations();
    const oldAuth = betterAuth(oldOptions);
    const context = await oldAuth.$context;
    const user = await context.test.saveUser(context.test.createUser({ name: 'Before', email: 'before@example.test', emailVerified: true }));
    await context.adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { retainedField: 'preserve-me' } });
    const beforeColumns = upgradeDatabase.prepare('PRAGMA table_info(user)').all();
    assert.equal(beforeColumns.some(field => field.name === 'sidebarPreferences'), false);
    const beforeRows = upgradeDatabase.prepare('SELECT * FROM user').all().map(row => ({ ...row }));
    const options = { ...oldOptions, user: { ...oldOptions.user,
      additionalFields: { retainedField: field, sidebarPreferences: field } } };
    await (await getMigrations(options)).runMigrations();
    const afterColumns = upgradeDatabase.prepare('PRAGMA table_info(user)').all();
    assert.deepEqual(afterColumns.filter(field => field.name !== 'sidebarPreferences'), beforeColumns);
    assert.equal(afterColumns.length, beforeColumns.length + 1);
    assert.equal(afterColumns.at(-1).notnull, 0);
    assert.equal(afterColumns.at(-1).dflt_value, null);
    assert.deepEqual(upgradeDatabase.prepare('SELECT * FROM user').all().map(row => {
      const { sidebarPreferences, ...previous } = row;
      assert.equal(sidebarPreferences, null);
      return previous;
    }), beforeRows);
    const auth = betterAuth(options);
    const { adapter } = await auth.$context;
    const value = '{"projects":{"p":false},"groups":{}}';
    await adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { sidebarPreferences: value } });
    assert.equal((await adapter.findOne({ model: 'user', where: [{ field: 'id', value: user.id }] })).sidebarPreferences, value);
    assert.equal((await context.adapter.findOne({ model: 'user', where: [{ field: 'id', value: user.id }] })).retainedField, 'preserve-me');
    // An older adapter's unrelated update must leave the additive field intact.
    // Real previous-controller session/profile rollback is qualified separately.
    await (await getMigrations(oldOptions)).runMigrations();
    await context.adapter.update({ model: 'user', where: [{ field: 'id', value: user.id }], update: { name: 'After' } });
    const fresh = await (await betterAuth(options).$context).adapter.findOne({ model: 'user', where: [{ field: 'id', value: user.id }] });
    assert.equal(fresh.sidebarPreferences, value);
    assert.equal(fresh.retainedField, 'preserve-me');
    assert.equal(fresh.name, 'After');
  } finally { human.dispose(); database.close(); upgradeDatabase.close(); }
});
