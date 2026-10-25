import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { activeRepos, updatePi, parseVersion, changelogRange, parseAnalysis, discover, syncRepo, testRepo, release, evergreen, usesUndocumentedApis, behavioralReview, registryVersions, assertReleaseFiles } from '../src/evergreen.js';
import { command, config, lock, pool, save, json } from '../src/runtime.js';

const root = path.resolve('tmp/tests');
async function fixture(t) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const repoData = (name, extra = {}) => ({ name, owner: { login: 'gee666' }, default_branch: 'master', ...extra });
const history = '# Changelog\n\n## 1.4.0\nNew API\n\n## 1.3.0\nFix\n\n## 1.2.0\nOld';

test('Pi update tries mise only on failure, verifies version, then updates extensions', async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'pi' && args.join() === 'update') throw Error('managed by mise');
    return args[0] === '--version' ? '1.4.0' : '';
  };
  assert.equal(await updatePi(run), '1.4.0');
  assert.deepEqual(calls, [['pi', 'update'], ['mise', 'upgrade', 'pi'], ['mise', 'reshim'], ['pi', '--version'], ['pi', 'update', '--extensions']]);
  calls.length = 0;
  await updatePi(async (bin, args) => { calls.push(bin); return args[0] === '--version' ? '1.4.0' : ''; });
  assert.ok(!calls.includes('mise'));
});

test('failed mise update aborts before extension update', async () => {
  const calls = [];
  await assert.rejects(updatePi(async (b, a) => { calls.push([b, ...a]); throw Error('failed'); }), /failed/);
  assert.equal(calls.length, 2);
});

test('strict versions and assessments fail closed', () => {
  assert.equal(parseVersion('v1.4.0'), '1.4.0');
  assert.throws(() => parseVersion('unknown'));
  assert.deepEqual(parseAnalysis('```json\n{"breaking":false,"usefulFeatures":true,"summary":"API"}\n```'), { breaking: false, usefulFeatures: true, summary: 'API' });
  assert.throws(() => parseAnalysis('{"breaking":"no"}'));
});

test('only active owned pi-* repositories qualify', () => {
  assert.deepEqual(activeRepos([repoData('pi-ok'), repoData('pi-archived', { archived: true }), repoData('pi-disabled', { disabled: true }), repoData('other'), repoData('pi-foreign', { owner: { login: 'other' } })], 'gee666').map(r => r.name), ['pi-ok']);
  assert.throws(() => activeRepos([repoData('pi-../../escape')], 'gee666'));
});

test('discovery paginates and includes private owned repositories', async () => {
  const calls = [];
  const repos = await discover(async (b, a) => {
    calls.push(a);
    return JSON.stringify(a[1] === 'user' ? { login: 'gee666' } : [[repoData('pi-a')], [repoData('pi-b')]]);
  });
  assert.equal(repos.length, 2);
  assert.ok(calls[1].includes('--paginate'));
  assert.match(calls[1].at(-1), /user\/repos.*visibility=all/);
});

test('changelog excludes previous version and refuses gaps', () => {
  assert.match(changelogRange(history, '1.3.0', '1.4.0'), /New API/);
  assert.doesNotMatch(changelogRange(history, '1.3.0', '1.4.0'), /Fix/);
  assert.match(changelogRange(history, undefined, '1.4.0'), /Old/);
  assert.throws(() => changelogRange(history, '0.9.0', '1.4.0'), /full version range/);
});

test('config reads settings model and env path, with explicit env priority', async t => {
  const dir = await fixture(t);
  await save(path.join(dir, 'settings.json'), { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', evergreen: { extensionsDir: dir } });
  const c = await config({ PI_CODING_AGENT_DIR: dir, PI_EVERGREEN_CONFIG: path.join(dir, 'absent.json'), 'PI-EXTENSIONS-DIR': path.join(dir, 'extensions'), PI_MODEL: 'other' });
  assert.equal(c.provider, 'openai-codex');
  assert.equal(c.model, 'other');
  assert.equal(c.extensionsDir, path.join(dir, 'extensions'));
});

test('exclusive lock rejects overlapping runs and releases', async t => {
  const dir = await fixture(t);
  const unlock = await lock(dir);
  await assert.rejects(lock(dir), /already running/);
  await unlock();
  await (await lock(dir))();
});

test('commands handle stdin, exit codes, deadlines and logs', async t => {
  const dir = await fixture(t);
  assert.equal(await command('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello', timeout: 2000, logFile: path.join(dir, 'log') }), 'hello');
  assert.match(await readFile(path.join(dir, 'log'), 'utf8'), /hello/);
  await assert.rejects(command('node', ['-e', 'process.exit(2)'], { timeout: 2000 }), /exited 2/);
  await assert.rejects(command('node', ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), /timed out/);
});

test('worker pool limits concurrency and reports all failures', async () => {
  let active = 0, max = 0, count = 0;
  await assert.rejects(pool(Array.from({ length: 5 }, (_, i) => ({ name: `r${i}` })), 2, async r => {
    active++; max = Math.max(max, active);
    await new Promise(resolve => setImmediate(resolve));
    active--; count++;
    if (r.name === 'r2') throw Error('bad');
  }), /r2: bad/);
  assert.equal(max, 2); assert.equal(count, 5);
});

test('tests override SDK to current Pi and missing tests are failures', async t => {
  const dir = await fixture(t);
  const pkg = { name: 'test', version: '1.0.0', devDependencies: { '@earendil-works/pi-coding-agent': '^1.0.0' }, scripts: { test: 'node --test', check: 'echo check' } };
  await save(path.join(dir, 'package.json'), pkg);
  const calls = [];
  const c = { piVersion: '1.4.0', testCommands: {} };
  const repo = { dir, name: 'pi-test' };
  assert.equal((await testRepo(async (b, a) => { calls.push([b, ...a]); return ''; }, repo, c, dir, 'initial')).passed, true);
  assert.ok(calls.some(a => a.includes('@earendil-works/pi-coding-agent@1.4.0')));
  delete pkg.scripts;
  await save(path.join(dir, 'package.json'), pkg);
  assert.equal((await testRepo(async () => '', repo, c, dir, 'initial')).passed, false);
});

async function workflowFixture(t, { changed = false, failTests = false, previous, failPublish = false, knowledge = true, relevant = changed } = {}) {
  const dir = await fixture(t);
  const extensionDir = path.join(dir, 'extensions');
  const repoDir = path.join(extensionDir, 'pi-test');
  const stateDir = path.join(dir, 'state');
  await mkdir(repoDir, { recursive: true });
  await save(path.join(repoDir, 'package.json'), { name: 'pi-test-package', version: '1.0.0', scripts: { test: 'echo ok' } });
  if (previous) await save(path.join(stateDir, 'state.json'), { version: previous, releases: {} });
  if (knowledge) await writeFile(path.join(repoDir, 'PI_COMPATIBILITY.md'), '<!-- pi-evergreen: {"usesUndocumentedApis": false} -->\n# Compatibility\nTool execution hooks are relevant.');
  const calls = [];
  let piVersion = '1.4.0';
  let dirty = false, head = 'base', initialFailure = failTests, publishFailure = failPublish;
  const run = async (b, a, opts = {}) => {
    calls.push({ b, a, opts });
    if (b === 'pi') {
      if (a[0] === '--version') return piVersion;
      if (a.includes('--no-tools')) return JSON.stringify({ breaking: changed, usefulFeatures: false, summary: 'Review APIs', extensions: [{ name: 'pi-test', relevant, reason: relevant ? 'Changed tool execution API' : 'Unrelated scrollbar change' }] });
      if (a.includes('--print')) {
        if (opts.input.includes('first-run compatibility knowledge subagent')) { await writeFile(path.join(opts.cwd, 'PI_COMPATIBILITY.md'), '<!-- pi-evergreen: {"usesUndocumentedApis": false} -->\n# Compatibility\nTools matter; scrollbar does not. Test: routes new tools'); dirty = true; }
        else dirty = changed || failTests;
        initialFailure = false; return 'Updated';
      }
      return '';
    }
    if (b === 'gh') {
      if (a[1] === 'user') return '{"login":"gee666"}';
      if (a.includes('--slurp')) return JSON.stringify([[repoData('pi-test')]]);
      return JSON.stringify({ content: Buffer.from(history).toString('base64') });
    }
    if (b === 'git') {
      if (a[0] === 'clone') { await cp(a.at(-2), a.at(-1), { recursive: true }); return ''; }
      if (a.includes('--show-toplevel')) return opts.cwd;
      if (a[0] === 'remote') return 'https://github.com/gee666/pi-test.git';
      if (a[0] === 'branch') return 'master';
      if (a[0] === 'status') return dirty ? ' M index.js' : '';
      if (a[0] === 'rev-list') return '0';
      if (a[0] === 'rev-parse') return head;
      if (a[0] === 'commit') { head = 'release-commit'; dirty = false; }
      return '';
    }
    if (b === 'bash') { if (initialFailure) throw Error('test failure'); return 'passed'; }
    if (b === 'npm') {
      if (a[0] === 'version') {
        const pkg = await json(path.join(opts.cwd, 'package.json')); pkg.version = a[1];
        await save(path.join(opts.cwd, 'package.json'), pkg); dirty = true;
      }
      if (a[0] === 'view') return '["1.0.0"]';
      if (a[0] === 'publish' && publishFailure) { publishFailure = false; throw Error('registry unavailable'); }
      return '';
    }
    throw Error('Unexpected command ' + b);
  };
  const c = { extensionsDir: extensionDir, stateDir, concurrency: 2, testCommands: {}, provider: 'openai-codex', model: 'gpt-6.1-sol', piVersion: '1.4.0', publishAccess: 'public' };
  return { c, run, calls, sourceDir: repoDir, setPiVersion: v => { piVersion = v; }, stateFile: path.join(stateDir, 'state.json') };
}

test('unchanged Pi still updates extensions and syncs but skips tests and AI', async t => {
  const f = await workflowFixture(t, { previous: '1.4.0' });
  await evergreen(f.c, { run: f.run });
  assert.ok(f.calls.some(x => x.a.includes('--extensions')));
  assert.ok(f.calls.some(x => x.a.includes('--ff-only')));
  assert.ok(!f.calls.some(x => x.b === 'bash' || x.a.includes('--print')));
});

test('first run checks full history and records baseline on bugfix-only release', async t => {
  const f = await workflowFixture(t);
  await evergreen(f.c, { run: f.run });
  assert.equal((await json(f.stateFile)).version, '1.4.0');
  assert.equal(f.calls.filter(x => x.a.includes('--print')).length, 1);
  assert.ok(!f.calls.some(x => x.a[0] === 'publish'));
});

test('breaking changes launch worker, retest, bump, commit, push then publish', async t => {
  const f = await workflowFixture(t, { changed: true, previous: '1.3.0' });
  await evergreen(f.c, { run: f.run });
  const actions = f.calls.map(x => x.a[0]);
  assert.equal(f.calls.filter(x => x.a.includes('--print')).length, 2);
  assert.ok(actions.indexOf('commit') < actions.indexOf('push'));
  assert.ok(actions.indexOf('push') < actions.indexOf('publish'));
  assert.equal((await json(f.stateFile)).releases['pi-test'].phase, 'done');
});

test('failed initial tests trigger worker even for bugfix-only changelog', async t => {
  const f = await workflowFixture(t, { failTests: true, previous: '1.3.0' });
  await evergreen(f.c, { run: f.run });
  assert.equal(f.calls.filter(x => x.a.includes('--print')).length, 2);
  assert.equal((await json(f.stateFile)).version, '1.4.0');
});

test('publish failure preserves baseline and resumes without a second bump or worker', async t => {
  const f = await workflowFixture(t, { changed: true, previous: '1.3.0', failPublish: true });
  await assert.rejects(evergreen(f.c, { run: f.run }), /registry unavailable/);
  assert.equal((await json(f.stateFile)).version, '1.3.0');
  assert.equal((await json(f.stateFile)).releases['pi-test'].phase, 'publish');
  await evergreen(f.c, { run: f.run });
  assert.equal(f.calls.filter(x => x.b === 'npm' && x.a[0] === 'version').length, 1);
  assert.equal(f.calls.filter(x => x.a.includes('--print')).length, 2);
  assert.equal((await json(f.stateFile)).version, '1.4.0');
});

test('dirty checkout aborts before pull', async t => {
  const dir = await fixture(t);
  const repo = { dir, name: 'pi-test', owner: 'gee666', branch: 'master' };
  const actions = [];
  await assert.rejects(syncRepo(async (b, a) => {
    actions.push(a[0]);
    if (a.includes('--show-toplevel')) return dir;
    if (a[0] === 'remote') return 'https://github.com/gee666/pi-test.git';
    if (a[0] === 'branch') return 'master';
    if (a[0] === 'status') return ' M file';
    return '';
  }, repo), /Dirty checkout/);
  assert.ok(!actions.includes('fetch'));
});


test('unrelated changes skip passing extensions even when global breaking flag is true', async t => {
  const f = await workflowFixture(t, { changed: true, relevant: false, previous: '1.3.0' });
  await evergreen(f.c, { run: f.run });
  assert.equal(f.calls.filter(x => x.a.includes('--print')).length, 1);
  assert.ok(!f.calls.some(x => x.a[0] === 'publish'));
});

test('first-run worker creates knowledge and tests before focused changelog analysis', async t => {
  const f = await workflowFixture(t, { knowledge: false, previous: '1.3.0' });
  await evergreen(f.c, { run: f.run });
  const sessions = f.calls.filter(x => x.a.includes('--print'));
  assert.equal(sessions.length, 2);
  assert.match(sessions[0].opts.input, /first-run compatibility knowledge subagent/);
  assert.match(sessions[1].opts.input, /Tools matter; scrollbar does not/);
  assert.equal((await json(f.stateFile)).releases['pi-test'].phase, 'done');
});

test('per-extension assessment must cover each repository exactly once', () => {
  const base = { breaking: false, usefulFeatures: true, summary: 'API' };
  assert.throws(() => parseAnalysis(JSON.stringify(base), ['pi-a']));
  assert.throws(() => parseAnalysis(JSON.stringify({ ...base, extensions: [{ name: 'pi-other', relevant: true, reason: 'API' }] }), ['pi-a']));
  assert.throws(() => parseAnalysis(JSON.stringify({ ...base, extensions: [{ name: 'pi-a', relevant: true, reason: 'API' }, { name: 'pi-a', relevant: false, reason: 'none' }] }), ['pi-a', 'pi-b']));
});


test('undocumented API declarations fail closed and creative review includes multi-turn risks', () => {
  assert.equal(usesUndocumentedApis('<!-- pi-evergreen: {"usesUndocumentedApis": false} -->'), false);
  assert.equal(usesUndocumentedApis('<!-- pi-evergreen: {"usesUndocumentedApis": true} -->'), true);
  assert.equal(usesUndocumentedApis('missing metadata'), true);
  assert.match(behavioralReview, /system prompt/);
  assert.match(behavioralReview, /every turn/);
  assert.match(behavioralReview, /green|passes/);
});

test('npm version discovery only treats E404 as an unpublished package', async () => {
  assert.deepEqual(await registryVersions(async () => { throw Error('E404 Not Found'); }, 'new', '.'), []);
  await assert.rejects(registryVersions(async () => { throw Error('E401 unauthorized'); }, 'new', '.'), /E401/);
});

test('release rejects protected instruction and credential files', async () => {
  for (const file of ['AGENTS.md', '.pi/AGENTS.override.md', '.env', '.npmrc', 'nested/auth.json']) {
    await assert.rejects(assertReleaseFiles(async (bin, args) => args[0] === 'diff' ? file + '\0' : '', '.'), /protected or credential/);
  }
});

test('kernel lock ignores stale lockfile contents', async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'run.lock'), 'old PID from a crashed process');
  await (await lock(dir))();
});


test('failed workers preserve managed edits without dirtying the canonical checkout', async t => {
  const f = await workflowFixture(t, { changed: true, previous: '1.3.0' });
  const failing = async (bin, args, opts) => {
    if (bin === 'pi' && args.includes('--print') && !args.includes('--no-tools')) {
      await writeFile(path.join(opts.cwd, 'worker-edit.txt'), 'unfinished fix');
      throw Error('worker interrupted');
    }
    return f.run(bin, args, opts);
  };
  await assert.rejects(evergreen(f.c, { run: failing }), /worker interrupted/);
  assert.equal((await json(f.stateFile)).version, '1.3.0');
  const state = await json(f.stateFile);
  assert.equal(await readFile(path.join(state.workspaces['pi-test'].dir, 'worker-edit.txt'), 'utf8'), 'unfinished fix');
  await assert.rejects(readFile(path.join(f.sourceDir, 'worker-edit.txt')), { code: 'ENOENT' });
  await evergreen(f.c, { run: f.run });
  assert.equal((await json(f.stateFile)).version, '1.4.0');
});

test('pending publications resume before attempting to install a newer Pi', async t => {
  const f = await workflowFixture(t, { changed: true, previous: '1.3.0', failPublish: true });
  await assert.rejects(evergreen(f.c, { run: f.run }), /registry unavailable/);
  f.calls.length = 0;
  const newerRun = async (bin, args, opts) => {
    if (bin === 'pi' && args[0] === 'update') throw Error('stop at update after recovery');
    if (bin === 'mise') throw Error('new Pi temporarily unavailable');
    return f.run(bin, args, opts);
  };
  await assert.rejects(evergreen(f.c, { run: newerRun }), /new Pi temporarily unavailable/);
  assert.equal((await json(f.stateFile)).releases['pi-test'].phase, 'done');
  assert.ok(f.calls.some(x => x.a[0] === 'publish'));
});

test('node-cron schedules 02:00 in the selected timezone', async () => {
  const { default: cron } = await import('node-cron');
  const task = cron.createTask('0 2 * * *', () => {}, { timezone: 'UTC' });
  try {
    await task.start();
    const next = task.getNextRun();
    assert.equal(next.getUTCHours(), 2);
    assert.equal(next.getUTCMinutes(), 0);
  } finally { await task.destroy(); }
});
