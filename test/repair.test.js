import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { acquireLock, backoff, command, createSupervisor, journalSummary, parseModelEnv, repairPrompt } from '../scripts/repair.mjs';

const modelLine = 'PI-AGENT-MODEL=openai/gpt-6.1-sol/medium\n';
const fixtureRoot = path.resolve('tmp/repair-tests');

async function fixture(t) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, 'run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  await mkdir(repo);
  const git = (...args) => command('git', args, { cwd: repo, timeout: 10_000 });
  await command('git', ['init', '--bare', '--initial-branch=main', origin], { timeout: 10_000 });
  await git('init', '--initial-branch=main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repo, '.gitignore'), '.state/\ntmp/\n.env\n');
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', publishConfig: { access: 'public' } }));
  await writeFile(path.join(repo, 'README.md'), 'Exact workflow: update, audit, test, release. Never skip intent.');
  await writeFile(path.join(repo, 'app.js'), 'broken\n');
  await mkdir(path.join(repo, 'scripts'));
  await writeFile(path.join(repo, 'scripts/repair.mjs'), '// supervisor authority\n');
  await git('add', '.'); await git('commit', '-m', 'initial fixture');
  await git('remote', 'add', 'origin', origin); await git('push', '-u', 'origin', 'main');
  await writeFile(path.join(repo, '.env'), modelLine + 'PI-GITHUB-OWNER=original\n');
  const events = [];
  const control = { auth: true, githubAuth: true, registryAuth: true, failTest: false, failOnce: false, failPush: false, active: false,
    failHealthy: false, failAgent: false, edit: true, onceEnv: false, agentMutation: null, crashAfterAdd: false, crashAfterCommit: false }; 
  const run = async (bin, args, opts) => {
    const event = { bin, args, opts }; events.push(event);
    assert.equal(opts.cwd, repo);
    assert.equal(opts.env.PI_EVERGREEN_REPAIR_ACTIVE, '1');
    if (bin === 'git') {
      if (args[0] === 'push' && control.failPush) throw new Error('sensitive push authentication output');
      const output = await command(bin, args, { ...opts, timeout: 10_000 });
      if ((args.includes('add') && !opts.env.GIT_INDEX_FILE && control.crashAfterAdd) || (args[0] === 'commit' && control.crashAfterCommit)) {
        control.crashAfterAdd = false; control.crashAfterCommit = false;
        throw new Error('simulated interruption after Git completed');
      }
      return output;
    }
    if (bin === 'systemctl') {
      if (args.includes('stop')) control.active = false;
      if (args.includes('is-active') && (!control.active || control.failHealthy)) throw new Error('inactive');
      return '';
    }
    if (bin === 'pi') {
      if (args[0] === 'auth') {
        assert.deepEqual(args, ['auth', 'check', '--provider', 'openai', '--model', 'gpt-6.1-sol']);
        if (!control.auth) throw new Error('secret credential must not be logged');
      } else {
        assert.deepEqual(args, ['--print', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve',
          '--provider', 'openai', '--model', 'gpt-6.1-sol', '--thinking', 'medium']);
        if (control.edit) await writeFile(path.join(repo, 'app.js'), 'fixed\n');
        await control.agentMutation?.();
        if (control.failAgent) throw new Error('agent deadline');
      }
      return '';
    }
    if (bin === 'journalctl') return 'Error: auth token=SUPER_SECRET at src/cli.js:12:3\nBearer KEEP_PRIVATE';
    if (bin === 'gh') {
      assert.deepEqual(args, ['auth', 'status']);
      if (!control.githubAuth) throw new Error('GitHub unauthenticated');
      return '';
    }
    if (bin === 'npm') {
      if (args.includes('whoami')) {
        assert.deepEqual(args, ['--global', 'whoami']); // Auth must not parse the broken local manifest.
        if (!control.registryAuth) throw new Error('npm unauthenticated');
      }
      if (args[0] === 'ci') JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
      if (args[0] === 'test' && control.failTest) throw new Error('tests failed');
      return '';
    }
    if (bin === 'node') {
      assert.deepEqual(args, ['src/cli.js', '--once']);
      if (control.onceEnv) await appendFile(path.join(repo, '.env'), "PI-TEST-COMMANDS-pi-example='[\"npm test\"]'\n");
      if (control.failOnce) throw new Error('external gh/npm auth unavailable');
      return '';
    }
    if (bin === 'bash') {
      assert.deepEqual(args, ['scripts/install-service.sh', '--deploy-from-repair']);
      control.active = true; return '';
    }
    throw new Error('Unexpected executable ' + bin);
  };
  const waits = [];
  const options = { root: repo, run, sleep: async ms => { waits.push(ms); }, healthyMs: 10 };
  const make = () => createSupervisor(options);
  return { root: repo, git, control, events, waits, make, options };
}
const calls = (f, bin, arg) => f.events.filter(e => e.bin === bin && (!arg || e.args.includes(arg)));

async function advanceOrigin(f) {
  const upstream = path.join(path.dirname(f.root), 'upstream');
  const git = (...args) => command('git', args, { cwd: upstream, timeout: 10_000 });
  await command('git', ['clone', (await f.git('remote', 'get-url', 'origin')).trim(), upstream], { timeout: 10_000 });
  await git('config', 'user.email', 'upstream@example.invalid');
  await git('config', 'user.name', 'Upstream fixture');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(upstream, 'app.js'), 'upstream fix\n');
  await git('add', '--', 'app.js'); await git('commit', '-m', 'upstream repair');
  await git('push', 'origin', 'main');
  return (await git('rev-parse', 'HEAD')).trim();
}

test('model parser requires explicit application setting and reasoning, without defaults', () => {
  for (const value of ['openai/gpt-6.1-sol/medium', "'openai/gpt-6.1-sol/medium'", '"openai/gpt-6.1-sol/medium" # selected']) {
    assert.deepEqual(parseModelEnv('UNRELATED=ignored\n PI-AGENT-MODEL = ' + value + '\n'),
      { provider: 'openai', model: 'gpt-6.1-sol', thinking: 'medium' });
  }
  assert.deepEqual(parseModelEnv('PI-AGENT-MODEL=provider/org/model/medium'), { provider: 'provider', model: 'org/model', thinking: 'medium' });
  for (const source of ['', 'PI-AGENT-MODEL=', 'PI-AGENT-MODEL=openai/model', 'PI-AGENT-MODEL=openai/model/unknown',
    'PI-AGENT-MODEL=openai//medium', 'PI-AGENT-MODEL="openai/model/medium',
    'PI-AGENT-MODEL=openai/$(oops)/medium', modelLine + modelLine]) assert.throws(() => parseModelEnv(source));
});

test('journal/prompt omit raw credentials and preserve non-negotiable workflow instructions', () => {
  const summary = journalSummary('Error secret=SUPER_SECRET Bearer PRIVATE at src/cli.js:12:3');
  assert.match(summary, /src\/cli.js:12:3/); assert.doesNotMatch(summary, /SUPER_SECRET|PRIVATE|Bearer/);
  const prompt = repairPrompt('Workflow sentinel', summary);
  for (const text of ['Workflow sentinel', 'scripts/repair.mjs', 'AGENTS.md', 'Do not commit or push', 'Do not disable',
    'authentication', 'owner or paths', 'model/provider', 'publish targets']) assert.ok(prompt.includes(text));
});

test('missing provider auth keeps retrying without LLM, installs, validation or commits', async t => {
  const f = await fixture(t); f.control.auth = false;
  const controller = new AbortController();
  const sleeps = [];
  const s = await createSupervisor({ ...f.options, signal: controller.signal, sleep: async ms => {
    sleeps.push(ms); if (sleeps.length === 3) controller.abort();
  } });
  assert.equal(await s.loop(), false);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(backoff(100), 900_000);
  assert.equal(calls(f, 'pi', 'auth').length, 3);
  for (const bin of ['npm', 'node', 'bash']) assert.equal(calls(f, bin).length, 0);
  assert.equal(calls(f, 'pi', '--print').length, 0);
  assert.equal(s.state.phase, 'blocked:auth');
  assert.match(s.state.reason, /waiting for credentials/);
  const log = await readFile(path.join(f.root, '.state/repair.log'), 'utf8');
  assert.doesNotMatch(log, /secret credential/);
  assert.equal(f.events[0].bin, 'systemctl'); assert.ok(f.events[0].args.includes('stop'));
});

test('dirty initial tracked and untracked user work is refused until clean', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'app.js'), 'user change\n');
  await writeFile(path.join(f.root, 'user-note.txt'), 'preserve me');
  const s = await f.make(); assert.equal(await s.cycle(), false);
  assert.equal(s.state.phase, 'blocked:blocked'); assert.equal(s.state.head, undefined);
  assert.equal(calls(f, 'pi').length, 0);
  assert.equal(await readFile(path.join(f.root, 'user-note.txt'), 'utf8'), 'preserve me');
  await f.git('restore', 'app.js'); await rm(path.join(f.root, 'user-note.txt'));
  assert.equal(await s.cycle(), true);
});

test('initial clean checkout fast-forwards upstream fixes before ownership without a model or new commit', async t => {
  const f = await fixture(t);
  const originalEnv = await readFile(path.join(f.root, '.env'), 'utf8');
  const upstreamHead = await advanceOrigin(f);
  const s = await f.make(); assert.equal(await s.cycle(), true);
  assert.equal(s.state.head, upstreamHead);
  assert.equal((await f.git('rev-parse', 'HEAD')).trim(), upstreamHead);
  assert.equal(await readFile(path.join(f.root, 'app.js'), 'utf8'), 'upstream fix\n');
  assert.equal(await readFile(path.join(f.root, '.env'), 'utf8'), originalEnv);
  assert.equal(calls(f, 'pi', '--print').length, 0);
  assert.equal(calls(f, 'git', 'commit').length, 0);
  assert.equal(calls(f, 'git', 'push').length, 0);
  assert.deepEqual(calls(f, 'git', 'fetch')[0].args, ['fetch', '--no-tags', 'origin', 'refs/heads/main']);
  assert.deepEqual(calls(f, 'git', 'merge')[0].args, ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', upstreamHead]);
  assert.ok(f.events.findIndex(e => e.bin === 'git' && e.args[0] === 'merge') < f.events.findIndex(e => e.bin === 'pi'));
  assert.equal((await f.git('status', '--porcelain')).trim(), '');
});

test('initial ahead or divergent local commits are refused without reset, merge or model calls', async t => {
  for (const mode of ['ahead', 'divergent']) {
    const f = await fixture(t);
    if (mode === 'divergent') await advanceOrigin(f);
    await writeFile(path.join(f.root, 'user-work.js'), 'preserve local commit\n');
    await f.git('add', '--', 'user-work.js'); await f.git('commit', '-m', 'user work');
    const localHead = (await f.git('rev-parse', 'HEAD')).trim();
    const s = await f.make(); assert.equal(await s.cycle(), false, mode);
    assert.equal(s.state.phase, 'blocked:blocked'); assert.equal(s.state.head, undefined);
    assert.equal((await f.git('rev-parse', 'HEAD')).trim(), localHead);
    assert.equal(await readFile(path.join(f.root, 'user-work.js'), 'utf8'), 'preserve local commit\n');
    assert.equal((await f.git('status', '--porcelain')).trim(), '');
    assert.equal(calls(f, 'git', 'merge').length, 0);
    assert.equal(calls(f, 'git', 'reset').length, 0);
    assert.equal(calls(f, 'pi').length, 0);
  }
});

test('full validation and healthy deployment precede exact staging, commit and non-force push', async t => {
  const f = await fixture(t); f.control.failTest = true;
  const s = await f.make(); assert.equal(await s.cycle(), false);
  assert.equal(calls(f, 'git', 'commit').length, 0); assert.equal(calls(f, 'bash').length, 0);
  f.control.failTest = false; f.control.onceEnv = true;
  await mkdir(path.join(f.root, '.state'), { recursive: true });
  await writeFile(path.join(f.root, '.state/extensions.md'), '# Shared knowledge\n');
  assert.equal(await s.cycle(), true);
  const meaningful = f.events.filter(e => e.bin !== 'git' || ['add', 'commit', 'push'].some(a => e.args.includes(a)));
  const index = (bin, arg) => meaningful.findIndex(e => e.bin === bin && e.args.includes(arg));
  assert.ok(index('pi', '--print') < index('node', '--once'));
  assert.ok(index('node', '--once') < index('bash', '--deploy-from-repair'));
  assert.ok(index('bash', '--deploy-from-repair') < index('git', 'commit'));
  assert.ok(index('git', 'commit') < index('git', 'push'));
  const beforeCommit = meaningful.slice(index('bash', '--deploy-from-repair'), index('git', 'commit'));
  assert.equal(beforeCommit.filter(e => e.bin === 'systemctl' && e.args.includes('is-active')).length, 2);
  assert.deepEqual(calls(f, 'git', 'add').find(e => !e.opts.env.GIT_INDEX_FILE).args, ['--literal-pathspecs', 'add', '--all', '--', 'app.js']);
  assert.deepEqual(calls(f, 'git', 'push')[0].args, ['push', 'origin', 'HEAD:refs/heads/main']);
  assert.equal((await f.git('status', '--porcelain')).trim(), '');
  assert.equal((await f.git('show', '--pretty=', '--name-only', 'HEAD')).trim(), 'app.js');
  assert.match(await readFile(path.join(f.root, '.env'), 'utf8'), /PI-TEST-COMMANDS-pi-example/);
  assert.equal(await readFile(path.join(f.root, '.state/extensions.md'), 'utf8'), '# Shared knowledge\n');
  assert.doesNotMatch(calls(f, 'pi', '--print')[0].opts.input, /SUPER_SECRET|KEEP_PRIVATE/);
  assert.equal(s.state.phase, 'done');
});

test('persisted own dirty edits survive retries; unrelated later additions block', async t => {
  const f = await fixture(t); f.control.failTest = true;
  let s = await f.make(); await s.cycle(); await s.cycle();
  assert.deepEqual(s.state.owned.files, ['app.js']);
  f.control.failTest = false; f.control.failPush = true;
  s = await f.make(); assert.equal(await s.cycle(), false);
  assert.equal(s.state.next, 'publish');
  await writeFile(path.join(f.root, 'user-addition.js'), 'user owned');
  const agentCount = calls(f, 'pi', '--print').length;
  s = await f.make(); assert.equal(await s.cycle(), false);
  assert.equal(s.state.phase, 'blocked:blocked');
  assert.equal(calls(f, 'pi', '--print').length, agentCount);
  assert.equal((await f.git('ls-files', 'user-addition.js')).trim(), '');
});

test('push auth retries reuse verified commit without model, tests, deploy or stopping main', async t => {
  const f = await fixture(t); f.control.failTest = true;
  let s = await f.make(); await s.cycle();
  f.control.failTest = false; f.control.failPush = true;
  assert.equal(await s.cycle(), false); assert.equal(s.state.next, 'publish');
  const head = await f.git('rev-parse', 'HEAD');
  const offset = f.events.length;
  s = await f.make(); f.control.failPush = false; f.control.auth = false;
  assert.equal(await s.cycle(), true);
  const retry = f.events.slice(offset);
  assert.equal(retry.filter(e => ['pi', 'npm', 'node', 'bash'].includes(e.bin)).length, 0);
  assert.equal(retry.filter(e => e.bin === 'systemctl' && e.args.includes('stop')).length, 0);
  assert.equal(retry.filter(e => e.bin === 'git' && e.args.includes('commit')).length, 0);
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
});

test('full workflow failure or unhealthy deployment never commits or claims success', async t => {
  for (const fault of ['failOnce', 'failHealthy']) {
    const f = await fixture(t); f.control.failTest = true;
    const s = await f.make(); await s.cycle();
    f.control.failTest = false; f.control[fault] = true;
    assert.equal(await s.cycle(), false);
    assert.equal(calls(f, 'git', 'commit').length, 0);
    assert.equal(calls(f, 'git', 'push').length, 0);
    assert.notEqual(s.state.next, 'publish');
  }
});

test('early scheduler failure during a pending push triggers full validation again', async t => {
  const f = await fixture(t); f.control.failPush = true; f.control.failTest = true;
  const s = await f.make(); await s.cycle();
  f.control.failTest = false; await s.cycle();
  assert.equal(s.state.next, 'publish'); f.control.active = false;
  const offset = f.events.length; f.control.failOnce = true;
  assert.equal(await s.cycle(), false);
  const retry = f.events.slice(offset);
  assert.ok(retry.some(e => e.bin === 'systemctl' && e.args.includes('stop')));
  assert.ok(retry.some(e => e.bin === 'node' && e.args.includes('--once')));
  assert.equal(retry.filter(e => e.bin === 'git' && e.args.includes('push')).length, 0);
});

test('agent cannot rewrite supervisor, env selections or package identity', async t => {
  for (const target of ['supervisor', 'env', 'mapping', 'package']) {
    const f = await fixture(t); f.control.failTest = true;
    const s = await f.make(); await s.cycle(); f.control.failTest = false;
    f.control.agentMutation = async () => {
      if (target === 'supervisor') await appendFile(path.join(f.root, 'scripts/repair.mjs'), '// weaken authority\n');
      if (target === 'env') await writeFile(path.join(f.root, '.env'), 'PI-AGENT-MODEL=openai-codex/other/low\n');
      if (target === 'mapping') await appendFile(path.join(f.root, '.env'), 'PI-TEST-COMMANDS-pi-example=x\n');
      if (target === 'package') await writeFile(path.join(f.root, 'package.json'), '{"name":"different"}');
    };
    assert.equal(await s.cycle(), false, target);
    assert.equal(calls(f, 'git', 'commit').length, 0, target);
    assert.equal(calls(f, 'bash').length, 0, target);
    assert.equal(calls(f, 'node').length, 0, target);
  }
});

test('ordinary commands bound deadlines/output and abort entire process groups', async t => {
  const cwd = path.resolve('.');
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeout: 50 }), /deadline/);
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { cwd, maxOutput: 100 }), /output limit/);
  assert.equal((await command(process.execPath, ['-e', 'process.stdout.write(process.env.PI_EVERGREEN_REPAIR_ACTIVE)'], { cwd })).trim(), '1');
  const controller = new AbortController();
  const pidFile = path.join(fixtureRoot, 'child-' + Date.now());
  await mkdir(fixtureRoot, { recursive: true });
  t.after(() => rm(pidFile, { force: true }));
  const pending = command(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`],
    { cwd, signal: controller.signal, timeout: 5000 });
  // Wait for spawn rather than assuming a fixed scheduling delay.
  let pid;
  for (let n = 0; n < 100; n++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid); controller.abort(); await assert.rejects(pending, /Stopped/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('independent flock excludes another supervisor and releases its pipe on cleanup', async t => {
  const f = await fixture(t);
  const release = await acquireLock(f.root);
  t.after(release);
  await assert.rejects(acquireLock(f.root), /busy|unavailable/);
  await release();
  const nextRelease = await acquireLock(f.root); await nextRelease();
});

test('only Node builtins are imported and completed incidents start fresh on next invocation', async t => {
  const source = await readFile(new URL('../scripts/repair.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(imports.length > 0); assert.ok(imports.every(name => name.startsWith('node:')));
  const f = await fixture(t); const s = await f.make(); assert.equal(await s.cycle(), true);
  f.control.auth = false;
  const next = await f.make(); assert.equal(await next.cycle(), false);
  assert.equal(next.state.phase, 'blocked:auth');
});

test('GitHub and npm auth failures also gate model calls, then credentials resume validation', async t => {
  for (const gate of ['githubAuth', 'registryAuth']) {
    const f = await fixture(t); f.control[gate] = false;
    const s = await f.make(); assert.equal(await s.cycle(), false);
    assert.equal(s.state.phase, 'blocked:auth');
    assert.equal(calls(f, 'pi', '--print').length, 0);
    assert.equal(calls(f, 'node').length, 0);
    assert.equal(calls(f, 'npm', 'ci').length, 0);
    f.control[gate] = true;
    assert.equal(await s.cycle(), true);
    assert.equal(calls(f, 'pi', '--print').length, 0);
  }
});

test('persisted commit intent recovers crashes after staging or commit without duplicate commits', async t => {
  for (const crash of ['crashAfterAdd', 'crashAfterCommit']) {
    const f = await fixture(t); f.control.failTest = true;
    let s = await f.make(); await s.cycle();
    f.control.failTest = false; f.control[crash] = true;
    assert.equal(await s.cycle(), false, crash);
    assert.ok(s.state.commitIntent, crash);
    assert.equal(s.state.next, 'publish');
    const attempts = calls(f, 'pi', '--print').length;
    s = await f.make(); assert.equal(await s.cycle(), true, crash);
    assert.equal(calls(f, 'pi', '--print').length, attempts);
    assert.equal((await f.git('rev-list', '--count', 'HEAD')).trim(), '2');
    assert.equal((await f.git('status', '--porcelain')).trim(), '');
    assert.equal(s.state.commitIntent, undefined);
  }
});

test('crash recovery refuses a user edit after staging rather than adopting it', async t => {
  const f = await fixture(t); f.control.failTest = true;
  let s = await f.make(); await s.cycle();
  f.control.failTest = false; f.control.crashAfterAdd = true; await s.cycle();
  await writeFile(path.join(f.root, 'app.js'), 'user change after interruption\n');
  s = await f.make(); assert.equal(await s.cycle(), false);
  assert.equal(calls(f, 'git', 'commit').length, 0);
  assert.equal(calls(f, 'git', 'push').length, 0);
  assert.equal(await readFile(path.join(f.root, 'app.js'), 'utf8'), 'user change after interruption\n');
});

test('first repair of a committed malformed manifest uses recent valid history and global npm auth', async t => {
  const f = await fixture(t);
  const baseline = await readFile(path.join(f.root, 'package.json'), 'utf8');
  for (const source of ['{"name":', '{malformed']) {
    await writeFile(path.join(f.root, 'package.json'), source);
    await f.git('add', '--', 'package.json'); await f.git('commit', '-m', 'broken fixture manifest');
  }
  await f.git('push', 'origin', 'main');
  assert.equal((await f.git('status', '--porcelain')).trim(), '');
  const s = await f.make();
  assert.equal(await s.cycle(), false);
  assert.equal(s.state.phase, 'blocked:validation');
  assert.equal(s.state.next, 'repair'); assert.ok(s.state.package);
  assert.deepEqual(calls(f, 'npm', 'whoami')[0].args, ['--global', 'whoami']);
  assert.equal(calls(f, 'pi', '--print').length, 0);
  assert.equal(calls(f, 'bash').length, 0);
  f.control.agentMutation = () => writeFile(path.join(f.root, 'package.json'), baseline);
  assert.equal(await s.cycle(), true);
  assert.equal((await f.git('show', '--pretty=', '--name-only', 'HEAD')).trim(), 'app.js\npackage.json');
  assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), baseline);
});

test('temporarily malformed owned package.json remains repairable but cannot deploy', async t => {
  const f = await fixture(t); f.control.failTest = true;
  let s = await f.make(); await s.cycle(); f.control.failTest = false;
  f.control.agentMutation = () => writeFile(path.join(f.root, 'package.json'), '{"name":');
  f.control.failAgent = true;
  assert.equal(await s.cycle(), false);
  assert.equal(s.state.next, 'validate');
  s = await f.make(); f.control.failAgent = false; f.control.agentMutation = null;
  assert.equal(await s.cycle(), false); // Real npm ci would reject the incomplete manifest.
  assert.equal(s.state.next, 'repair');
  assert.equal(calls(f, 'bash').length, 0);
  f.control.agentMutation = async () => {
    await writeFile(path.join(f.root, 'package.json'), await f.git('show', 'HEAD:package.json'));
  };
  assert.equal(await s.cycle(), true);
  assert.equal((await f.git('show', '--pretty=', '--name-only', 'HEAD')).trim(), 'app.js');
});
