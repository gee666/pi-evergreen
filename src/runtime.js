import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const expand = (p) => path.resolve(p.replace(/^~(?=\/|$)/, homedir()));
export async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

export async function config(env = process.env) {
  const agentDir = expand(env.PI_CODING_AGENT_DIR || '~/.pi/agent');
  const settings = await json(path.join(agentDir, 'settings.json'), {});
  const file = expand(env.PI_EVERGREEN_CONFIG || '~/.config/pi-evergreen/settings.json');
  const local = await json(file, {});
  const s = { ...settings.evergreen, ...local };
  const dir = env['PI-EXTENSIONS-DIR'] || env.PI_EXTENSIONS_DIR || s['PI-EXTENSIONS-DIR'] || s.extensionsDir || settings['PI-EXTENSIONS-DIR'];
  if (!dir) throw new Error('Set PI_EXTENSIONS_DIR or extensionsDir in ' + file);
  const result = {
    extensionsDir: expand(dir),
    stateDir: expand(env.PI_EVERGREEN_STATE_DIR || s.stateDir || '~/.local/state/pi-evergreen'),
    owner: env.PI_EVERGREEN_GITHUB_OWNER || s.githubOwner,
    provider: env.PI_EVERGREEN_PROVIDER || env.PI_PROVIDER || s.provider || settings.defaultProvider,
    model: env.PI_EVERGREEN_MODEL || env.PI_MODEL || s.model || settings.defaultModel,
    timezone: env.TZ || s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    concurrency: Number(env.PI_EVERGREEN_CONCURRENCY || s.concurrency || 2),
    commandTimeoutMs: s.commandTimeoutMs ?? 20 * 60_000,
    agentTimeoutMs: s.agentTimeoutMs ?? 90 * 60_000,
    testCommands: s.testCommands || {},
    publishAccess: s.publishAccess || 'public',
  };
  if (!result.provider || !result.model) throw new Error('Configure provider and model in Pi settings or evergreen settings/env');
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 8) throw new Error('concurrency must be 1..8');
  for (const key of ['commandTimeoutMs', 'agentTimeoutMs']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1000) throw new Error(`${key} must be an integer >= 1000`);
  }
  new Intl.DateTimeFormat('en', { timeZone: result.timezone });
  return result;
}

// Deadlines kill the child's process group. The systemd service also contains descendants.
export function command(bin, args = [], { cwd, timeout = 20 * 60_000, input, logFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' },
    });
    let stdout = '', stderr = '', failure;
    const max = 8 * 1024 * 1024;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const terminate = () => { kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
    process.once('exit', kill);
    const timer = setTimeout(() => { failure = new Error(`${bin} timed out after ${timeout}ms`); terminate(); }, timeout);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', chunk => {
        if (name === 'stdout') stdout += chunk; else stderr += chunk;
        if (stdout.length + stderr.length > max) { failure = new Error(`${bin} output exceeded 8 MiB`); terminate(); }
      });
    }
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', e => { clearTimeout(timer); process.removeListener('exit', kill); reject(e); });
    child.on('close', async code => {
      clearTimeout(timer);
      process.removeListener('exit', kill);
      try {
        if (logFile) await writeFile(logFile, stdout + '\n' + stderr, { mode: 0o600 });
        if (failure) throw failure;
        if (code !== 0) throw new Error(`${bin} ${args.slice(0, 3).join(' ')} exited ${code}\n${stderr.slice(-4000)}\n${stdout.slice(-4000)}`);
        resolve(stdout.trim());
      } catch (e) { reject(e); }
    });
  });
}

// Linux advisory lock releases automatically on exit or machine restart.
// The holder exits when the parent's stdin pipe closes, including after SIGKILL.
export async function lock(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const holder = spawn('flock', ['--nonblock', path.join(dir, 'run.lock'), process.execPath, '-e', "process.stdout.write('locked\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false;
  let diagnostic = '';
  const closed = new Promise(resolve => holder.once('close', resolve));
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.stderr.on('data', chunk => { diagnostic += chunk; });
    holder.stdout.once('data', () => { ready = true; resolve(); });
    holder.once('close', () => { if (!ready) reject(new Error('Evergreen is already running, or flock failed: ' + diagnostic)); });
  });
  return async () => { holder.stdin.end(); await closed; };
}

export async function pool(items, concurrency, task) {
  let cursor = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try { await task(item); } catch (error) { errors.push(new Error(`${item.name}: ${error.message}`)); }
    }
  }));
  if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join('\n'));
}
