import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './io.ts';
import { extractSummary } from './pure.ts';
import type { Repo } from './repos.ts';

export async function testRepos(repos: Repo[], runDir: string, env: NodeJS.ProcessEnv) {
  console.log('Testing initialized repositories sequentially');
  const testsDir = join(runDir, 'tests');
  await mkdir(testsDir, { recursive: true });
  const rows = ['| Repo | Exit code | Log path |', '| --- | --- | --- |'];
  for (const repo of repos) {
    const log = join(testsDir, `${repo.name}.log`);
    console.log(`Testing ${repo.name}, log: ${log}`);
    // Leave the checkout clean: repos without a committed lockfile must not get one.
    const installArgs = existsSync(join(repo.path, 'package-lock.json'))
      ? ['ci'] : ['install', '--no-package-lock'];
    const install = await command('npm', installArgs, repo.path, env, log);
    const result = install.code === 0
      ? await command('npm', ['run', 'test:evergreen'], repo.path, env, log)
      : install;
    console.log(`${repo.name}: exit ${result.code}`);
    rows.push(`| ${repo.name} | ${result.code} | ${log} |`);
  }
  const summary = join(testsDir, 'summary.md');
  await writeFile(summary, `${rows.join('\n')}\n`);
  return summary;
}

export async function writeManifest(repos: Repo[], runDir: string) {
  console.log('Writing repository manifest');
  const entries = await Promise.all(repos.map(async (repo) => {
    const evergreen = join(repo.path, 'EVERGREEN.md');
    return `## ${repo.name}\n\nRepo: ${repo.path}\nEVERGREEN.md: ${evergreen}\n\n` +
      `${extractSummary(await readFile(evergreen, 'utf8'))}\n`;
  }));
  const manifest = join(runDir, 'manifest.md');
  await writeFile(manifest, entries.join('\n'));
  return manifest;
}
