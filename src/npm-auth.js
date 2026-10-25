import { readFile, lstat, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Mirrored in the standalone supervisor so broken app modules cannot prevent repair.
export async function prepareNpmAuth(root) {
  const file = path.join(root, '.env');
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => /^\s*(?:export\s+)?NPM_TOKEN\s*=/.test(line));
  if (lines.length > 1) throw new Error('Duplicate NPM_TOKEN in application .env');
  if (!lines.length) return { env: {}, dispose: async () => {} };
  const match = lines[0].match(/^\s*(?:export\s+)?NPM_TOKEN\s*=\s*(?:"([A-Za-z0-9_-]*)"|'([A-Za-z0-9_-]*)'|([A-Za-z0-9_-]*))\s*(?:#.*)?$/);
  if (!match) throw new Error('Invalid NPM_TOKEN format in application .env');
  const token = match[1] ?? match[2] ?? match[3];
  if (!token) return { env: {}, dispose: async () => {} };
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Application .env must be a private regular file, chmod 600 .env');
  const tmp = path.join(root, 'tmp');
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const tmpStat = await lstat(tmp);
  if (tmpStat.isSymbolicLink() || !tmpStat.isDirectory() || (process.platform !== 'win32' && (tmpStat.mode & 0o022))) throw new Error('Credential temporary directory must not be a symlink or writable by other users');
  const directory = await mkdtemp(path.join(tmp, 'npm-auth-'));
  try {
    const source = process.env.NPM_CONFIG_USERCONFIG || process.env.npm_config_userconfig || path.join(homedir(), '.npmrc');
    let previous = '';
    try { previous = await readFile(source, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read existing npm configuration'); }
    const userconfig = path.join(directory, 'npmrc');
    await writeFile(userconfig, previous.trimEnd() + '\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', { mode: 0o600 });
    return { env: { NPM_TOKEN: token, NPM_CONFIG_USERCONFIG: userconfig, npm_config_userconfig: userconfig }, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
