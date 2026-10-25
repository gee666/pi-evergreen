import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execute = promisify(execFile);

test('installer deploys both units without a restart loop or stopping its repair supervisor', async t => {
  const root = path.resolve('tmp/service-tests');
  await mkdir(root, { recursive: true });
  for (const args of [[], ['--deploy-from-repair']]) {
    const home = await mkdtemp(path.join(root, 'home-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const bin = path.join(home, '.local/bin');
    await mkdir(bin, { recursive: true });
    for (const name of ['node', 'npm']) await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const log = path.join(home, 'systemctl.log');
    await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"\n', { mode: 0o700 });
    await execute('/bin/bash', ['scripts/install-service.sh', ...args], { cwd: path.resolve('.'), env: { ...process.env, HOME: home, SERVICE_TEST_LOG: log }, timeout: 10_000 });
    const app = await readFile(path.join(home, '.config/systemd/user/pi-evergreen.service'), 'utf8');
    const repair = await readFile(path.join(home, '.config/systemd/user/pi-evergreen-repair.service'), 'utf8');
    const calls = await readFile(log, 'utf8');
    assert.match(app, /OnFailure=pi-evergreen-repair\.service/);
    assert.match(app, /Restart=no/);
    assert.match(app, /SuccessExitStatus=130 143/);
    assert.match(repair, /ExecStart=.*scripts\/repair\.mjs/);
    assert.match(repair, /Restart=on-failure/);
    assert.match(repair, /Environment=PI_EVERGREEN_REPAIR_ACTIVE=1/);
    assert.match(calls, /--user daemon-reload/);
    assert.match(calls, /--user enable pi-evergreen\.service/);
    assert.match(calls, /--user restart pi-evergreen\.service/);
    assert.doesNotMatch(calls, /(?:stop|restart) pi-evergreen-repair/);
  }
});
