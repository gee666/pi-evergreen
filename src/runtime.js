import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

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

export function modelSpec(value, key) {
  const parts = value.split('/');
  const provider = parts.shift();
  const reasoning = parts.pop();
  const model = parts.join('/');
  if (!provider || !model || /\s/.test(value) || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning)) throw new Error(`${key} must be provider/model/reasoning-level with an explicit valid reasoning level`);
  return { provider, model, reasoning };
}

export async function config(file = fileURLToPath(new URL('../.env', import.meta.url))) {
  let values;
  try { values = parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing Evergreen env file: ${file}. Fill in the blank .env.example template and save it as .env.`);
    throw error;
  }
  const keys = ['PI-EXTENSIONS-DIR', 'PI-STATE-DIR', 'PI-GITHUB-OWNER', 'PI-AGENT-MODEL', 'PI-E2E-MODEL', 'PI-TIMEZONE', 'PI-CONCURRENCY', 'PI-COMMAND-TIMEOUT-MS', 'PI-AGENT-TIMEOUT-MS', 'PI-PUBLISH-ACCESS'];
  const missing = keys.filter(key => !values[key]?.trim());
  if (missing.length) throw new Error(`Missing required Evergreen settings in ${file}: ${missing.join(', ')}`);
  const agent = modelSpec(values['PI-AGENT-MODEL'], 'PI-AGENT-MODEL');
  const e2e = modelSpec(values['PI-E2E-MODEL'], 'PI-E2E-MODEL');
  const result = {
    extensionsDir: expand(values['PI-EXTENSIONS-DIR']),
    stateDir: expand(values['PI-STATE-DIR']),
    owner: values['PI-GITHUB-OWNER'],
    provider: agent.provider, model: agent.model, reasoning: agent.reasoning,
    e2eProvider: e2e.provider, e2eModel: e2e.model, e2eReasoning: e2e.reasoning,
    timezone: values['PI-TIMEZONE'],
    concurrency: Number(values['PI-CONCURRENCY']),
    commandTimeoutMs: Number(values['PI-COMMAND-TIMEOUT-MS']),
    agentTimeoutMs: Number(values['PI-AGENT-TIMEOUT-MS']),
    publishAccess: values['PI-PUBLISH-ACCESS'],
    testCommands: values['PI-TEST-COMMANDS']?.trim() ? JSON.parse(values['PI-TEST-COMMANDS']) : undefined,
  };
  if (!/^[\w.-]+$/.test(result.owner)) throw new Error('PI-GITHUB-OWNER is invalid');
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 8) throw new Error('PI-CONCURRENCY must be 1..8');
  for (const key of ['commandTimeoutMs', 'agentTimeoutMs']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1000) throw new Error(`${key} must be an integer >= 1000`);
  }
  if (!['public', 'restricted'].includes(result.publishAccess)) throw new Error('PI-PUBLISH-ACCESS must be public or restricted');
  if (result.testCommands !== undefined && (!result.testCommands || typeof result.testCommands !== 'object' || Array.isArray(result.testCommands))) throw new Error('PI-TEST-COMMANDS must be a JSON object');
  new Intl.DateTimeFormat('en', { timeZone: result.timezone });
  return result;
}

// Deadlines kill the child's process group. The systemd service also contains descendants.
export function command(bin, args = [], { cwd, timeout = 20 * 60_000, input, logFile, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', CI: '1' },
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
