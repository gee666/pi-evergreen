#!/usr/bin/env node
import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { config, command } from './runtime.js';
import { evergreen } from './evergreen.js';
import { requestRepair } from './repair-trigger.js';

process.once('SIGTERM', () => process.exit(143));
process.once('SIGINT', () => process.exit(130));

try {
  if (process.argv.slice(2).some(a => !['--once', '--check-config'].includes(a))) throw new Error('Usage: node src/cli.js [--once | --check-config]');
  const settings = await config();
  if (process.argv.includes('--check-config')) console.log(JSON.stringify(settings, null, 2));
  else if (process.argv.includes('--once')) await evergreen(settings);
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
  if (!process.argv.includes('--check-config')) requestRepair();
  process.exitCode = 1;
}
