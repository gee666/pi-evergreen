import path from 'node:path';
import { lstat, readdir, rm } from 'node:fs/promises';

const DAY = 24 * 60 * 60_000;

async function statIfPresent(file) {
  try { return await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Check ancestors too: lstat on a leaf alone can traverse a symlinked parent.
async function assertDirectoryPath(dir) {
  const parent = path.dirname(dir);
  if (parent !== dir) await assertDirectoryPath(parent);
  const stat = await statIfPresent(dir);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error('Cleanup path must contain only real directories: ' + dir);
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function prune(dir, cutoff) {
  const stat = await statIfPresent(dir);
  // In particular, never follow a symlink used as the runs directory.
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return 0;
  let removed = 0;
  for (const name of await readdir(dir)) {
    const entry = path.join(dir, name);
    const entryStat = await statIfPresent(entry);
    if (!entryStat || entryStat.mtimeMs >= cutoff) continue;
    // rm unlinks symlinks, including nested ones, without following targets.
    await rm(entry, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Remove expired top-level entries only. Call under the global lock before creating a run. */
export async function cleanup({ stateDir, tmpDir, now = Date.now() }) {
  if (typeof stateDir !== 'string' || !stateDir.trim() || typeof tmpDir !== 'string' || !tmpDir.trim()) {
    throw new Error('Cleanup requires nonempty stateDir and tmpDir paths');
  }
  if (!Number.isFinite(now)) throw new Error('Cleanup now must be a finite timestamp');
  stateDir = path.resolve(stateDir);
  tmpDir = path.resolve(tmpDir);
  if ([stateDir, tmpDir].some(dir => path.dirname(dir) === dir)
      || contains(stateDir, tmpDir) || contains(tmpDir, stateDir)) {
    throw new Error('Cleanup directories must not be roots, equal, or overlapping');
  }
  await assertDirectoryPath(stateDir);
  await assertDirectoryPath(tmpDir);
  return {
    runsRemoved: await prune(path.join(stateDir, 'runs'), now - 14 * DAY),
    tmpRemoved: await prune(tmpDir, now - 7 * DAY),
  };
}
