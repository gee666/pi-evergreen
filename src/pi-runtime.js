import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function isLocalDependency(file) {
  return file.split(/[\\/]/).includes('node_modules');
}

async function executablePath(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || isLocalDependency(candidate)) return null;
  try {
    const resolved = await realpath(candidate);
    if (isLocalDependency(resolved) || !(await stat(resolved)).isFile()) return null;
    await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

/** Resolve the existing global Pi executable without installing a runtime. */
export async function resolvePiBinary(run, env = process.env) {
  try {
    const output = await run('mise', ['which', 'pi']);
    const candidate = typeof output === 'string' ? output.trim() : '';
    const resolved = await executablePath(candidate);
    if (resolved) return resolved;
  } catch {
    // mise is optional. Do not include command errors, which may contain secrets.
  }

  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    // An empty PATH entry denotes the current directory, not a global install.
    if (!directory) continue;
    const resolved = await executablePath(path.resolve(directory, 'pi'));
    if (resolved) return resolved;
  }

  throw new Error('No existing global Pi executable found. Ensure Pi is installed globally and available through mise or PATH; node_modules executables are not allowed.');
}
