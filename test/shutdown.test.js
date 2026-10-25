import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, cp, symlink, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

test('normal scheduler SIGTERM and SIGINT exit successfully, not as repair failures', async t => {
  await mkdir('tmp/shutdown-tests', { recursive: true });
  const root = await mkdtemp(path.resolve('tmp/shutdown-tests/run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp('src', path.join(root, 'src'), { recursive: true });
  await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, '.env'), `PI-EXTENSIONS-DIR=${root}\nPI-GITHUB-OWNER=fixture\nPI-AGENT-MODEL=fixture/model/medium\nPI-E2E-MODEL=fixture/cheap/low\nPI-TIMEZONE=UTC\nPI-CONCURRENCY=1\nPI-COMMAND-TIMEOUT-MS=1000\nPI-AGENT-TIMEOUT-MS=1000\nPI-PUBLISH-ACCESS=public\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const child = spawn(process.execPath, [path.join(root, 'src/cli.js')], { env: { ...process.env, PI_EVERGREEN_REPAIR_ACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', sent = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (!sent && output.includes('Evergreen scheduled')) { sent = true; child.kill(signal); }
      });
      child.once('close', (code, received) => resolve({ code, received }));
    }).finally(() => clearTimeout(timer));
    assert.ok(sent, 'scheduler started');
    assert.deepEqual(result, { code: 0, received: null });
  }
});
