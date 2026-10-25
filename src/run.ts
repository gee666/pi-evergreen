import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNpmrc, firstRuns, masterAgent } from './agents.ts';
import { loadConfig, projectDir } from './config.ts';
import { readOptional } from './io.ts';
import { resolvePi, updatePi } from './pi.ts';
import { decideRun, type State } from './pure.ts';
import { syncRepos } from './repos.ts';
import { testRepos, writeManifest } from './steps.ts';

async function readState(path: string): Promise<State> {
  const text = await readOptional(path);
  if (text === undefined) return {};
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    ('lastPiVersion' in value && typeof value.lastPiVersion !== 'string') ||
    ('lastDepsUpdateMonth' in value && (typeof value.lastDepsUpdateMonth !== 'string' ||
      !/^\d{4}-\d{2}$/.test(value.lastDepsUpdateMonth)))) {
    throw new Error('Invalid state.json');
  }
  return {
    ...('lastPiVersion' in value && typeof value.lastPiVersion === 'string'
      ? { lastPiVersion: value.lastPiVersion } : {}),
    ...('lastDepsUpdateMonth' in value && typeof value.lastDepsUpdateMonth === 'string'
      ? { lastDepsUpdateMonth: value.lastDepsUpdateMonth } : {}),
  };
}

async function saveState(path: string, state: State): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2) + '\n');
  console.log('Saved state');
}

async function run(): Promise<void> {
  const config = loadConfig();
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const runDir = join(projectDir, '.state', 'runs', now.toISOString().replace(/[:.]/g, '-'));
  await mkdir(runDir, { recursive: true });
  console.log(`Run directory: ${runDir}`);
  const statePath = join(projectDir, '.state', 'state.json');
  const state = await readState(statePath);
  await updatePi(projectDir);
  const pi = await resolvePi(projectDir);
  const { repos, pullFailures } = await syncRepos(config);
  const npmrc = await createNpmrc(runDir);
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc,
    EVERGREEN_PI_BIN: pi.binary, EVERGREEN_E2E_MODEL: config.e2eModel };
  try {
    const initialized = await firstRuns(repos, config, runDir, env, pullFailures);
    const decision = decideRun(state, pi.version, month);
    console.log(`Decision: baseline=${decision.baseline}, run=${decision.run}, deps=${decision.depsUpdate}`);
    if (decision.baseline) {
      await saveState(statePath, { ...state, lastPiVersion: pi.version });
      return;
    }
    if (!decision.run) return;
    const testSummary = await testRepos(initialized, runDir, env);
    const manifest = await writeManifest(initialized, runDir);
    const code = await masterAgent(config, runDir, env, {
      testSummary, manifest, lastVersion: state.lastPiVersion ?? '',
      newVersion: pi.version, changelog: pi.changelog,
      depsUpdate: String(decision.depsUpdate), pullFailures: pullFailures.join('\n') || 'None',
    });
    if (code !== 0) {
      console.log(`Master exited ${code}; state unchanged for next night's retry`);
      process.exitCode = 1;
      return;
    }
    await saveState(statePath, { ...state, lastPiVersion: pi.version,
      ...(decision.depsUpdate ? { lastDepsUpdateMonth: month } : {}) });
  } finally {
    await rm(npmrc);
  }
}

run().catch((error: unknown) => {
  console.log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
