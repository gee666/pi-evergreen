import { fileURLToPath } from 'node:url';

export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export const agentsDir = fileURLToPath(new URL('../agents/', import.meta.url));
export const promptsDir = fileURLToPath(new URL('../prompts/', import.meta.url));

export function loadConfig() {
  function required(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Missing ${key} in .env`);
    return value;
  }
  return {
    extensionsDir: required('EVERGREEN_EXTENSIONS_DIR'),
    owner: required('EVERGREEN_GITHUB_OWNER'),
    model: required('EVERGREEN_MODEL'),
    juniorModel: required('EVERGREEN_JUNIOR_MODEL'),
    e2eModel: required('EVERGREEN_E2E_MODEL'),
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function modelPreset(value: string) {
  const match = /^([^/]+)\/(.+):(off|minimal|low|medium|high|xhigh|max)$/.exec(value);
  if (!match) throw new Error(`Expected provider/model:thinking, got ${value}`);
  return { provider: match[1], model: match[2], 'reasoning-level': match[3] };
}
