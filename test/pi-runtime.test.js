import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolvePiBinary } from '../src/pi-runtime.js';

const root = fileURLToPath(new URL('../tmp/pi-runtime-tests/', import.meta.url));

async function fixture(t) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'case-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function executable(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return file;
}

function runner(result, fails = false) {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    assert.deepEqual(args, ['mise', ['which', 'pi']], 'only discovery, never installation');
    if (fails) throw new Error('mise unavailable: secret-command-output');
    return result;
  };
  return { run, calls };
}

test('mise wins over PATH and pins the current installed version through symlinks', async t => {
  const dir = await fixture(t);
  const installed = await executable(path.join(dir, 'installs/pi/1.2.3/pi/pi'));
  const latest = path.join(dir, 'installs/pi/latest');
  await symlink('1.2.3', latest);
  const shim = await executable(path.join(dir, 'shims/pi'));
  const { run, calls } = runner(`  ${latest}/pi/pi\n`);
  assert.equal(await resolvePiBinary(run, { PATH: path.dirname(shim) }), await realpath(installed));
  assert.equal(calls.length, 1);
});

test('missing mise skips npm-local PATH shadow and picks global Pi', async t => {
  const dir = await fixture(t);
  const local = await executable(path.join(dir, 'project/node_modules/.bin/pi'));
  const global = await executable(path.join(dir, 'global/bin/pi'));
  const { run, calls } = runner(null, true);
  assert.equal(await resolvePiBinary(run, { PATH: [path.dirname(local), path.dirname(global)].join(path.delimiter) }), await realpath(global));
  assert.equal(calls.length, 1);
});

test('PATH fallback canonicalizes a global symlink', async t => {
  const dir = await fixture(t);
  const target = await executable(path.join(dir, 'versions/2/pi'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await symlink(target, path.join(bin, 'pi'));
  const { run } = runner(null, true);
  assert.equal(await resolvePiBinary(run, { PATH: bin }), await realpath(target));
});

for (const invalid of ['missing', 'directory', 'non-executable', 'relative', 'multiline', 'local']) {
  test(`invalid mise result falls back: ${invalid}`, async t => {
    const dir = await fixture(t);
    const global = await executable(path.join(dir, 'global/pi'));
    let candidate = path.join(dir, 'invalid/pi');
    if (invalid === 'directory') await mkdir(candidate, { recursive: true });
    if (invalid === 'non-executable') {
      await executable(candidate);
      await chmod(candidate, 0o644);
    }
    if (invalid === 'relative') candidate = 'relative/pi';
    if (invalid === 'multiline') candidate = `${global}\n${global}`;
    if (invalid === 'local') candidate = await executable(path.join(dir, 'node_modules/pkg/pi'));
    const { run } = runner(candidate);
    assert.equal(await resolvePiBinary(run, { PATH: path.dirname(global) }), await realpath(global));
  });
}

test('PATH rejects directories, missing files, non-executables and symlinks into node_modules', async t => {
  const dir = await fixture(t);
  const directory = path.join(dir, 'directory');
  await mkdir(path.join(directory, 'pi'), { recursive: true });
  const plain = await executable(path.join(dir, 'plain/pi'));
  await chmod(plain, 0o644);
  const local = await executable(path.join(dir, 'node_modules/pkg/pi'));
  const linked = path.join(dir, 'linked');
  await mkdir(linked);
  await symlink(local, path.join(linked, 'pi'));
  const { run, calls } = runner(null, true);
  await assert.rejects(resolvePiBinary(run, {
    PATH: [path.join(dir, 'missing'), directory, path.dirname(plain), linked].join(path.delimiter),
    PRIVATE_TOKEN: 'secret-env-value',
  }), error => {
    assert.match(error.message, /No existing global Pi executable found/);
    assert.doesNotMatch(error.message, /secret-command-output|secret-env-value/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('absent global Pi errors without installer calls or environment disclosure', async t => {
  const dir = await fixture(t);
  const local = await executable(path.join(dir, 'project/node_modules/.bin/pi'));
  const { run, calls } = runner(null, true);
  for (const env of [{}, { PATH: '' }, { PATH: path.dirname(local) }]) {
    await assert.rejects(resolvePiBinary(run, env), /No existing global Pi executable found/);
  }
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['mise', ['which', 'pi']]));
});
