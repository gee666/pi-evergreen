import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, lutimes, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { cleanup } from '../src/cleanup.js';

const root = path.resolve('tmp/cleanup-tests');
const DAY = 24 * 60 * 60_000;
const now = Date.UTC(2026, 9, 25, 12);

async function fixture(t) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, '.state');
  const tmpDir = path.join(dir, 'tmp');
  await mkdir(path.join(stateDir, 'runs'), { recursive: true });
  await mkdir(tmpDir);
  return { dir, stateDir, tmpDir, now };
}

async function aged(file, age, directory = false) {
  if (directory) {
    await mkdir(file, { recursive: true });
    await writeFile(path.join(file, 'contents'), 'keep or remove with parent');
  } else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'contents');
  }
  const time = new Date(now - age);
  await utimes(file, time, time);
  return file;
}

async function missing(file) {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
}

test('fixed retention removes only entries strictly older than 14 and 7 days', async t => {
  const f = await fixture(t);
  for (const [dir, days] of [[path.join(f.stateDir, 'runs'), 14], [f.tmpDir, 7]]) {
    await aged(path.join(dir, 'old-file'), days * DAY + 1000);
    await aged(path.join(dir, 'old-directory'), days * DAY + 1000, true);
    await aged(path.join(dir, 'boundary'), days * DAY);
    await aged(path.join(dir, 'recent'), days * DAY - 1000, true);
    await aged(path.join(dir, 'future'), -DAY);
  }
  assert.deepEqual(await cleanup(f), { runsRemoved: 2, tmpRemoved: 2 });
  for (const dir of [path.join(f.stateDir, 'runs'), f.tmpDir]) {
    assert.deepEqual((await readdir(dir)).sort(), ['boundary', 'future', 'recent']);
  }
  assert.deepEqual(await cleanup(f), { runsRemoved: 0, tmpRemoved: 0 });
});

test('preserves all other state, workspaces and abandoned cloning workspaces', async t => {
  const f = await fixture(t);
  const files = ['state.json', 'recovery.json', 'recovery/journal.json', 'workspaces/repo/contents', 'workspaces/abandoned.cloning/contents'];
  for (const file of files) await aged(path.join(f.stateDir, file), 100 * DAY);
  await aged(path.join(f.stateDir, 'runs', 'expired'), 15 * DAY, true);
  assert.deepEqual(await cleanup(f), { runsRemoved: 1, tmpRemoved: 0 });
  for (const file of files) assert.equal(await readFile(path.join(f.stateDir, file), 'utf8'), 'contents');
  for (const dir of [f.stateDir, path.join(f.stateDir, 'runs'), f.tmpDir]) assert.ok((await lstat(dir)).isDirectory());
});

test('uses top-level mtime, preserving old children in fresh entries including live tests', async t => {
  const f = await fixture(t);
  for (const dir of [path.join(f.stateDir, 'runs', 'active'), path.join(f.tmpDir, 'tests')]) {
    await aged(path.join(dir, 'old-child'), 100 * DAY);
    await utimes(dir, new Date(now), new Date(now));
  }
  assert.deepEqual(await cleanup(f), { runsRemoved: 0, tmpRemoved: 0 });
  assert.equal(await readFile(path.join(f.tmpDir, 'tests', 'old-child'), 'utf8'), 'contents');
});

test('unlinks expired symlinks without following targets, including nested links', async t => {
  const f = await fixture(t);
  const target = await aged(path.join(f.dir, 'outside'), 100 * DAY, true);
  for (const dir of [path.join(f.stateDir, 'runs'), f.tmpDir]) {
    const link = path.join(dir, 'old-link');
    await symlink(target, link);
    await lutimes(link, new Date(now - 100 * DAY), new Date(now - 100 * DAY));
    const nested = path.join(dir, 'old-directory');
    await mkdir(nested);
    await symlink(target, path.join(nested, 'link'));
    await utimes(nested, new Date(now - 100 * DAY), new Date(now - 100 * DAY));
  }
  assert.deepEqual(await cleanup(f), { runsRemoved: 2, tmpRemoved: 2 });
  assert.equal(await readFile(path.join(target, 'contents'), 'utf8'), 'keep or remove with parent');
});

test('does not follow a symlinked runs directory', async t => {
  const f = await fixture(t);
  const runs = path.join(f.stateDir, 'runs');
  await rm(runs, { recursive: true });
  const target = await aged(path.join(f.dir, 'outside'), 100 * DAY, true);
  await symlink(target, runs);
  assert.deepEqual(await cleanup(f), { runsRemoved: 0, tmpRemoved: 0 });
  assert.ok((await lstat(runs)).isSymbolicLink());
  assert.equal(await readFile(path.join(target, 'contents'), 'utf8'), 'keep or remove with parent');
});

test('missing directories are harmless and are not created', async t => {
  const f = await fixture(t);
  await rm(f.stateDir, { recursive: true });
  await rm(f.tmpDir, { recursive: true });
  assert.deepEqual(await cleanup(f), { runsRemoved: 0, tmpRemoved: 0 });
  await missing(f.stateDir);
  await missing(f.tmpDir);
  await mkdir(f.stateDir);
  await cleanup(f);
  await missing(path.join(f.stateDir, 'runs'));
});

test('rejects roots, equal or overlapping paths, empty paths and invalid timestamps before deletion', async t => {
  const f = await fixture(t);
  const old = await aged(path.join(f.stateDir, 'runs', 'old'), 100 * DAY);
  for (const overrides of [
    { stateDir: '/' }, { tmpDir: '/' }, { tmpDir: f.stateDir },
    { tmpDir: path.join(f.stateDir, 'runs') }, { stateDir: f.tmpDir + '/nested' },
    { tmpDir: path.join(f.stateDir, 'runs', '..') },
    { stateDir: '' }, { tmpDir: ' ' }, { stateDir: null }, { now: NaN }, { now: Infinity },
  ]) await assert.rejects(cleanup({ ...f, ...overrides }));
  assert.equal(await readFile(old, 'utf8'), 'contents');
});

test('rejects symlinked input directories and ancestors before deleting anything', async t => {
  const f = await fixture(t);
  const old = await aged(path.join(f.stateDir, 'runs', 'old'), 100 * DAY);
  const alias = path.join(f.dir, 'alias');
  await symlink(f.tmpDir, alias);
  await assert.rejects(cleanup({ ...f, tmpDir: alias }), /real directories/);
  await assert.rejects(cleanup({ ...f, tmpDir: path.join(alias, 'nested') }), /real directories/);
  await assert.rejects(cleanup({ ...f, stateDir: alias }), /real directories/);
  const file = await aged(path.join(f.dir, 'not-directory'), 100 * DAY);
  await assert.rejects(cleanup({ ...f, tmpDir: file }), /real directories/);
  assert.equal(await readFile(old, 'utf8'), 'contents');
});
