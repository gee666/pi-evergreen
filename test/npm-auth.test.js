import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, chmod, readdir } from 'node:fs/promises';
import { prepareNpmAuth } from '../src/npm-auth.js';
import { prepareNpmAuth as bootstrapAuth } from '../scripts/repair.mjs';
import { command, config } from '../src/runtime.js';

async function fixture(t) {
  await mkdir('tmp/npm-auth-tests', { recursive: true });
  const dir = await mkdtemp(path.resolve('tmp/npm-auth-tests/run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('main and standalone repair use identical builtin-only npm credential handling', () => {
  assert.equal(prepareNpmAuth.toString(), bootstrapAuth.toString());
});

for (const [name, prepare] of [['application', prepareNpmAuth], ['repair', bootstrapAuth]]) {
  test(`${name} passes credentials through a private npmrc and environment, not literal config`, async t => {
    const root = await fixture(t);
    await writeFile(path.join(root, '.env'), 'NPM_TOKEN=npm_fixture_private\n', { mode: 0o600 });
    const auth = await prepare(root);
    const file = auth.env.NPM_CONFIG_USERCONFIG;
    assert.equal(auth.env.NPM_TOKEN, 'npm_fixture_private');
    assert.equal(auth.env.npm_config_userconfig, file);
    const contents = await readFile(file, 'utf8');
    assert.match(contents, /_authToken=\$\{NPM_TOKEN\}/);
    assert.doesNotMatch(contents, /npm_fixture_private/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    await auth.dispose();
    await assert.rejects(stat(file), { code: 'ENOENT' });
  });
  test(`${name} accepts an empty placeholder, rejects malformed or public token files`, async t => {
    const root = await fixture(t), file = path.join(root, '.env');
    await writeFile(file, 'NPM_TOKEN=\n', { mode: 0o600 });
    assert.deepEqual((await prepare(root)).env, {});
    for (const text of ['NPM_TOKEN=one\nNPM_TOKEN=two\n', 'NPM_TOKEN="not a token"\n']) {
      await writeFile(file, text);
      await assert.rejects(prepare(root), /Duplicate|Invalid/);
    }
    await writeFile(file, 'NPM_TOKEN=npm_fixture_private\n');
    await chmod(file, 0o644);
    await assert.rejects(prepare(root), /private/);
  });
}

test('command results, logs and failures redact the active npm token', async t => {
  const root = await fixture(t), log = path.join(root, 'log');
  const env = { NPM_TOKEN: 'npm_fixture_private' };
  const text = await command(process.execPath, ['-e', 'process.stdout.write(process.env.NPM_TOKEN)'], { env, timeout: 5000, logFile: log });
  assert.equal(text, '[REDACTED]');
  assert.doesNotMatch(await readFile(log, 'utf8'), /npm_fixture_private/);
  await assert.rejects(command(process.execPath, ['-e', 'console.error(process.env.NPM_TOKEN);process.exit(1)'], { env, timeout: 5000 }), error => !error.message.includes(env.NPM_TOKEN));
});
