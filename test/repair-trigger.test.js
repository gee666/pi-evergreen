import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requestRepair } from '../src/repair-trigger.js';

test('failed app requests a separate systemd-managed repair process without waiting', () => {
  const calls = [];
  assert.equal(requestRepair({ env: {}, execute: (...args) => { calls.push(args); return { status: 0 }; } }), true);
  assert.equal(calls[0][0], 'systemctl');
  assert.deepEqual(calls[0][1], ['--user', 'start', '--no-block', 'pi-evergreen-repair.service']);
  assert.equal(calls[0][2].timeout, 10000);
});

test('repair validation cannot recursively trigger another repair supervisor', () => {
  assert.equal(requestRepair({ env: { PI_EVERGREEN_REPAIR_ACTIVE: '1' }, execute: () => { throw Error('must not execute'); } }), false);
});

test('units isolate repair lifetime and restart it independently, without restart races', async () => {
  const source = await readFile('scripts/install-service.sh', 'utf8');
  assert.match(source, /OnFailure=pi-evergreen-repair\.service/);
  assert.match(source, /Restart=no/);
  assert.match(source, /Restart=on-failure/);
  assert.match(source, /PI_EVERGREEN_REPAIR_ACTIVE=1/);
  assert.match(source, /scripts\/repair\.mjs/);
  assert.match(source, /--deploy-from-repair/);
});
