import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { readTestCommands, writeTestCommands, workerReport, readKnowledge, writeKnowledge } from '../src/metadata.js';

async function fixture(t) {
  const root = path.resolve('tmp/metadata-tests');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('concurrent agent command updates preserve both entries, comments and operator settings', async t => {
  const file = path.join(await fixture(t), '.env');
  await writeFile(file, '# operator notes\nPI-AGENT-MODEL=openai/gpt-6.1-sol/medium\nPI-E2E-MODEL=openai/gpt-6-luna/medium\n');
  await Promise.all([
    writeTestCommands(file, 'pi-a', ['npm test', 'npm run check']),
    writeTestCommands(file, 'pi-b', ['npm test', 'npm run test:e2e']),
  ]);
  const source = await readFile(file, 'utf8');
  assert.match(source, /# operator notes/);
  const values = parse(source);
  assert.equal(values['PI-AGENT-MODEL'], 'openai/gpt-6.1-sol/medium');
  assert.deepEqual(readTestCommands(values), { 'pi-a': ['npm test', 'npm run check'], 'pi-b': ['npm test', 'npm run test:e2e'] });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('agent mapping updates its own key and deduplicates it without changing other entries', async t => {
  const file = path.join(await fixture(t), '.env');
  await writeFile(file, "PI-TEST-COMMANDS-pi-a='[\"old\"]'\nPI-TEST-COMMANDS-pi-b='[\"keep\"]'\nPI-TEST-COMMANDS-pi-a='[\"duplicate\"]'\n");
  await writeTestCommands(file, 'pi-a', ['npm test']);
  const source = await readFile(file, 'utf8');
  assert.equal(source.match(/PI-TEST-COMMANDS-pi-a=/g).length, 1);
  assert.deepEqual(readTestCommands(parse(source)), { 'pi-a': ['npm test'], 'pi-b': ['keep'] });
});

test('test commands round-trip shell quotes, hash characters and all dotenv delimiters', async t => {
  const file = path.join(await fixture(t), '.env');
  await writeFile(file, 'PI-TIMEZONE=UTC\n');
  for (const command of ['npm test', "printf '%s' '#value'", "printf '%s' `node -e 'console.log(1)'` # comment"]) {
    await writeTestCommands(file, 'pi-a', [command]);
    assert.deepEqual(readTestCommands(parse(await readFile(file, 'utf8')))['pi-a'], [command]);
  }
});

test('reports and env commands fail closed on empty, malformed or multiline data', () => {
  for (const text of ['not json', '{}', '{"knowledge":"<!-- evergreen:pi-b:start -->","testCommands":["npm test"]}', '{"knowledge":"","testCommands":["npm test"]}', '{"knowledge":"notes","testCommands":[]}', '{"knowledge":"notes","testCommands":["echo ok\\nPI-AGENT-MODEL=wrong"]}']) assert.throws(() => workerReport(text));
  assert.throws(() => readTestCommands({ 'PI-TEST-COMMANDS-pi-a': '["ok", ""]' }));
  assert.throws(() => readTestCommands({ 'PI-TEST-COMMANDS-other': '["npm test"]' }));
  assert.deepEqual(workerReport('```json\n{"knowledge":"notes","testCommands":["npm test"]}\n```'), { knowledge: 'notes', testCommands: ['npm test'] });
});

test('one plain Markdown knowledge file retains all extension sections', async t => {
  const file = path.join(await fixture(t), 'extensions.md');
  assert.deepEqual(await readKnowledge(file), {});
  const notes = { 'pi-b': 'Intent: route tools.\n### Coverage\n- test/routes.test.js', 'pi-a': 'Intent: replace prompts.\n### Coverage\n- test/prompts.e2e.js' };
  await writeKnowledge(file, notes);
  const source = await readFile(file, 'utf8');
  assert.match(source, /^# Extension compatibility notes/);
  assert.match(source, /## pi-a/);
  assert.match(source, /## pi-b/);
  assert.ok(source.indexOf('## pi-a') < source.indexOf('## pi-b'));
  assert.deepEqual(await readKnowledge(file), notes);
  notes['pi-a'] = 'Updated intent and coverage';
  await writeKnowledge(file, notes);
  assert.deepEqual(await readKnowledge(file), notes);
});

test('malformed or duplicate Markdown sections are not silently overwritten', async t => {
  const file = path.join(await fixture(t), 'extensions.md');
  await writeFile(file, '<!-- evergreen:pi-a:start -->\nunfinished\n');
  await assert.rejects(readKnowledge(file), /Malformed/);
  const block = '<!-- evergreen:pi-a:start -->\nnotes\n<!-- evergreen:pi-a:end -->\n';
  await writeFile(file, block + block);
  await assert.rejects(readKnowledge(file), /Duplicate/);
  await assert.rejects(writeKnowledge(file, { 'pi-a': '<!-- evergreen:pi-b:start -->' }), /Invalid/);
});
