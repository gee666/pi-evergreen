import { spawnSync } from 'node:child_process';

// systemd owns the repair process, not the failing application process.
export function requestRepair({ env = process.env, execute = spawnSync } = {}) {
  if (env.PI_EVERGREEN_REPAIR_ACTIVE === '1') return false;
  const result = execute('systemctl', ['--user', 'start', '--no-block', 'pi-evergreen-repair.service'], { timeout: 10_000, stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    console.error('Could not start the independent repair service. Check systemctl --user status pi-evergreen-repair.');
    return false;
  }
  return true;
}
