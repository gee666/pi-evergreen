import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { modelPreset, promptsDir, type Config } from './config.ts';
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

export async function firstRuns(repos: Repo[], config: Config, runDir: string,
  env: NodeJS.ProcessEnv, pullFailures: string[]): Promise<Repo[]> {
  console.log('Initializing repositories without EVERGREEN.md in parallel');
  const initialized = await Promise.all(repos.map(async (repo) => {
    const evergreen = join(repo.path, 'EVERGREEN.md');
    if (existsSync(evergreen)) return repo;
    const log = join(runDir, `first-run-${repo.name}.log`);
    console.log(`Initializing ${repo.name}, log: ${log}`);
    const text = await prompt('first-run', {
      repoPath: repo.path, workerPrompt: join(promptsDir, 'worker.md'),
      pullFailures: pullFailures.join('\n') || 'None',
    });
    const code = await spawnAgent(repo.path, text, config, env, log);
    if (code === 0 && existsSync(evergreen)) {
      console.log(`Initialized ${repo.name}`);
      return repo;
    }
    console.log(`${repo.name}: initialization incomplete, exit ${code}; retry next night`);
    return undefined;
  }));
  return initialized.filter((repo) => repo !== undefined);
}

export async function masterAgent(config: Config, runDir: string, env: NodeJS.ProcessEnv,
  values: Record<string, string>): Promise<number> {
  console.log('Writing subagent presets and launching the master agent');
  const piDir = join(config.extensionsDir, '.pi');
  await mkdir(piDir, { recursive: true });
  await writeFile(join(piDir, 'pi-subagent.json'), JSON.stringify({
    'subagents-models': [
      { junior: modelPreset(config.juniorModel) },
      { worker: modelPreset(config.model) },
    ],
    limits: { total: 1000, tasksPerCall: 100, concurrency: 100 },
    runner: { idleTimeoutMs: 0 },
  }, null, 2) + '\n');
  const text = await prompt('master', {
    ...values, runDir, workerPrompt: join(promptsDir, 'worker.md'),
    rulesPath: join(promptsDir, 'rules.md'), reportPath: join(runDir, 'report.md'),
  });
  return spawnAgent(config.extensionsDir, text, config, env, join(runDir, 'master.log'));
}
