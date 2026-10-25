import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentsDir, modelPreset, promptsDir, type Config } from './config.ts';
import { command, readOptional } from './io.ts';
import type { Repo } from './repos.ts';

export async function createNpmrc(runDir: string): Promise<string> {
  const existing = await readOptional(join(homedir(), '.npmrc')) ?? '';
  const path = join(runDir, 'npmrc');
  await writeFile(path, `${existing}\n//registry.npmjs.org/:_authToken=\${NPM_TOKEN}\n`, { mode: 0o600 });
  return path;
}

async function prompt(name: string, values: Record<string, string>): Promise<string> {
  const template = await readFile(join(promptsDir, `${name}.md`), 'utf8');
  const filled = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing prompt value ${key}`);
    return value;
  });
  return `${filled}\n${await readFile(join(promptsDir, 'rules.md'), 'utf8')}`;
}

async function spawnAgent(cwd: string, text: string, config: Config,
  env: NodeJS.ProcessEnv, log: string): Promise<number> {
  const result = await command('pi', ['-p', '--approve', '--model', config.model, text], cwd, env, log);
  if (result.output.trim()) console.log(result.output.trim());
  return result.code;
}

// Committed, not merely present: a crashed first run can leave an uncommitted EVERGREEN.md.
async function isInitialized(repoPath: string): Promise<boolean> {
  const result = await command('git', ['cat-file', '-e', 'HEAD:EVERGREEN.md'], repoPath);
  return result.code === 0;
}

export async function firstRuns(repos: Repo[], config: Config, runDir: string,
  env: NodeJS.ProcessEnv, pullFailures: string[]): Promise<Repo[]> {
  console.log('Initializing repositories without EVERGREEN.md in parallel');
  const initialized = await Promise.all(repos.map(async (repo) => {
    if (await isInitialized(repo.path)) return repo;
    const log = join(runDir, `first-run-${repo.name}.log`);
    console.log(`Initializing ${repo.name}, log: ${log}`);
    const text = await prompt('first-run', {
      repoPath: repo.path, workerPrompt: join(agentsDir, 'maintainer.md'),
      pullFailures: pullFailures.join('\n') || 'None',
    });
    const code = await spawnAgent(repo.path, text, config, env, log);
    if (code === 0 && await isInitialized(repo.path)) {
      console.log(`Initialized ${repo.name}`);
      return repo;
    }
    console.log(`${repo.name}: initialization incomplete, exit ${code}; retry next night`);
    return undefined;
  }));
  return initialized.filter((repo) => repo !== undefined);
}

export async function installAgentCards(config: Config): Promise<void> {
  const piDir = join(config.extensionsDir, '.pi');
  const cardsDir = join(piDir, 'agents');
  await mkdir(cardsDir, { recursive: true });
  const rules = await readFile(join(promptsDir, 'rules.md'), 'utf8');
  for (const name of ['maintainer', 'test-summarizer']) {
    const card = await readFile(join(agentsDir, `${name}.md`), 'utf8');
    await writeFile(join(cardsDir, `${name}.md`), `${card}\n${rules}`);
  }
  await writeFile(join(piDir, 'pi-subagent.json'), JSON.stringify({
    'subagents-models': [
      { junior: modelPreset(config.juniorModel) },
      { worker: modelPreset(config.model) },
    ],
    agents: { confirmProject: 'never' },
    limits: { total: 1000, tasksPerCall: 100, concurrency: 100 },
    runner: { idleTimeoutMs: 0 },
  }, null, 2) + '\n');
}

export async function masterAgent(config: Config, runDir: string, env: NodeJS.ProcessEnv,
  values: Record<string, string>): Promise<number> {
  console.log('Installing subagent cards and presets, then launching the master agent');
  await installAgentCards(config);
  const text = await prompt('master', {
    ...values, runDir, reportPath: join(runDir, 'report.md'),
  });
  return spawnAgent(config.extensionsDir, text, config, env, join(runDir, 'master.log'));
}
