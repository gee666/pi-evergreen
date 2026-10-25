import path from 'node:path';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { fileURLToPath } from 'node:url';

export async function atomicText(file, text) {
  const directory = fileURLToPath(new URL('../tmp/', import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, '.evergreen-' + randomUUID());
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export const testPrefix = 'PI-TEST-COMMANDS-';
export function validateCommands(commands) {
  if (!Array.isArray(commands) || !commands.length || commands.some(c => typeof c !== 'string' || !c.trim() || /[\r\n\0]/.test(c))) throw new Error('Test commands must be a nonempty array of single-line shell commands');
  return commands;
}
export function readTestCommands(values) {
  const result = {};
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(testPrefix)) continue;
    const name = key.slice(testPrefix.length);
    if (!/^pi-[\w.-]+$/.test(name)) throw new Error('Invalid repository test entry: ' + key);
    const data = raw.startsWith('base64:') ? Buffer.from(raw.slice(7), 'base64').toString('utf8') : raw;
    result[name] = validateCommands(JSON.parse(data));
  }
  return result;
}

// Each agent supplies its own commands. Only the parent writes the shared env file.
// Serialize read/modify/write operations and preserve unrelated operator settings.
const writes = new Map();
export function writeTestCommands(file, name, commands) {
  if (!/^pi-[\w.-]+$/.test(name)) throw new Error('Invalid repository name');
  validateCommands(commands);
  file = path.resolve(file);
  const previous = writes.get(file) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const source = await readFile(file, 'utf8');
    const key = testPrefix + name;
    const data = JSON.stringify(commands);
    const value = !data.includes("'") ? `'${data}'` : !data.includes('`') ? '`' + data + '`' : 'base64:' + Buffer.from(data).toString('base64');
    const line = `${key}=${value}`;
    let replaced = false;
    const updated = source.split(/\r?\n/).flatMap(old => {
      if (old.match(/^\s*([\w.-]+)\s*=/)?.[1] !== key) return [old];
      if (replaced) return [];
      replaced = true;
      return [line];
    }).join('\n');
    const output = replaced ? updated : updated.trimEnd() + '\n' + line + '\n';
    // Verify dotenv round-trips the commands, including shell quotes and # characters.
    if (JSON.stringify(readTestCommands(parse(output))[name]) !== data) throw new Error('Test-command env serialization failed');
    await atomicText(file, output);
  });
  writes.set(file, pending);
  pending.finally(() => { if (writes.get(file) === pending) writes.delete(file); }).catch(() => {});
  return pending;
}

export function workerReport(text) {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, ''));
  if (typeof value.knowledge !== 'string' || !value.knowledge.trim() || value.knowledge.length > 16000 || value.knowledge.includes('<!-- evergreen:')) throw new Error('Worker must return concise nonempty knowledge under 16 KB');
  validateCommands(value.testCommands);
  return value;
}

export async function readKnowledge(file) {
  let source;
  try { source = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const knowledge = {};
  const blocks = /<!-- evergreen:(pi-[\w.-]+):start -->\n([\s\S]*?)\n<!-- evergreen:\1:end -->/g;
  for (const match of source.matchAll(blocks)) {
    if (knowledge[match[1]] !== undefined) throw new Error('Duplicate extension knowledge: ' + match[1]);
    knowledge[match[1]] = match[2];
  }
  if (source.includes('<!-- evergreen:') && source.match(/<!-- evergreen:/g).length !== Object.keys(knowledge).length * 2) throw new Error('Malformed extension knowledge section markers');
  return knowledge;
}

export async function writeKnowledge(file, knowledge) {
  const source = '# Extension compatibility notes\n\nManaged by Evergreen. Each section describes an extension\'s intent, Pi dependencies and regression coverage.\n\n' + Object.entries(knowledge).sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => {
    if (!/^pi-[\w.-]+$/.test(name) || typeof body !== 'string' || body.includes('<!-- evergreen:')) throw new Error('Invalid extension knowledge section');
    return `## ${name}\n\n<!-- evergreen:${name}:start -->\n${body.trim()}\n<!-- evergreen:${name}:end -->\n`;
  }).join('\n');
  await atomicText(file, source);
}
