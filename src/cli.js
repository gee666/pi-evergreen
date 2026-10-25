#!/usr/bin/env node
import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { config, command } from './runtime.js';
import { evergreen } from './evergreen.js';
import { requestRepair } from './repair-trigger.js';
import { prepareNpmAuth } from './npm-auth.js';

process.once('SIGTERM', () => process.exit(143));
process.once('SIGINT', () => process.exit(130));

try {
  if (process.argv.slice(2).some(a => !['--once', '--check-config', '--check-auth'].includes(a))) throw new Error('Usage: node src/cli.js [--once | --check-config | --check-auth]');
  const settings = await config();
  if (process.argv.includes('--check-config')) console.log(JSON.stringify(settings, null, 2));
  else if (process.argv.includes('--once') || process.argv.includes('--check-auth')) {
    const auth = await prepareNpmAuth(settings.appDir);
    const run = (bin, args, opts = {}) => command(bin, args, { timeout: settings.commandTimeoutMs, ...opts, env: { ...opts.env, ...auth.env } });
    try {
      if (process.argv.includes('--check-auth')) {
        const user = await run('gh', ['api', 'user', '--jq', '.login']);
        if (user.toLowerCase() !== settings.owner.toLowerCase()) throw new Error('Authenticated GitHub account differs from PI-GITHUB-OWNER');
        console.log('GitHub: authenticated as ' + user);
        console.log('npm: authenticated as ' + await run('npm', ['--global', 'whoami']));
        for (const [provider, model] of [[settings.provider, settings.model], [settings.e2eProvider, settings.e2eModel]]) {
          await run('pi', ['auth', 'check', '--provider', provider, '--model', model]);
          console.log('Pi: ready for ' + provider + '/' + model);
        }
        await run('git', ['push', '--dry-run', 'origin', 'HEAD']);
        console.log('Git push: dry-run passed');
      } else await evergreen(settings, { run });
    } finally { await auth.dispose(); }
  }
  else {
    // Reload settings each night, so provider/model changes do not need a restart.
    cron.schedule('0 2 * * *', async () => {
      // A fresh process picks up updates to Evergreen itself without restarting the scheduler.
      try { console.log(await command(process.execPath, [fileURLToPath(import.meta.url), '--once'], { timeout: 24 * 60 * 60_000 })); }
      catch (error) { console.error(new Date().toISOString(), error.stack); process.exit(1); }
    }, { timezone: settings.timezone, noOverlap: true });
    console.log(`Evergreen scheduled for 02:00 in ${settings.timezone}. Timezone changes require a restart.`);
  }
} catch (error) {
  console.error(error.stack);
  if (!process.argv.includes('--check-config') && !process.argv.includes('--check-auth')) requestRepair();
  process.exitCode = 1;
}
