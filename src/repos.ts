import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { checked, command, readOptional } from './io.ts';
import { isManagedPackage, isRepoCandidate } from './pure.ts';

export type Repo = { name: string; path: string };

export async function listRepos(owner: string, cwd: string) {
  const output = await checked('gh', ['repo', 'list', owner, '--limit', '1000',
    '--json', 'name,isArchived,url'], cwd);
  const repos: unknown = JSON.parse(output);
  if (!Array.isArray(repos)) throw new Error('Expected a GitHub repository list');
  return repos.filter(isRepoCandidate);
}

export async function syncRepos(config: Config) {
  console.log(`Syncing repositories for ${config.owner}`);
  await mkdir(config.extensionsDir, { recursive: true });
  const candidates = await listRepos(config.owner, config.extensionsDir);
  const repos: Repo[] = [];
  const pullFailures: string[] = [];
  for (const repo of candidates) {
    const path = join(config.extensionsDir, repo.name);
    if (existsSync(path)) {
      console.log(`Pulling ${repo.name}`);
      const result = await command('git', ['pull', '--ff-only'], path);
      if (result.output.trim()) console.log(result.output.trim());
      if (result.code !== 0) pullFailures.push(`${repo.name}: ${result.output.trim()}`);
    } else {
      console.log(`Cloning ${repo.name}`);
      await checked('git', ['clone', repo.url, path], config.extensionsDir);
    }
    const text = await readOptional(join(path, 'package.json'));
    if (text !== undefined && isManagedPackage(JSON.parse(text))) {
      repos.push({ name: repo.name, path });
    }
  }
  return { repos, pullFailures };
}
