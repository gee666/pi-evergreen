import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { checked, command } from './io.ts';

export async function updatePi(cwd: string): Promise<void> {
  console.log('Updating Pi through mise and updating installed extensions');
  await checked('mise', ['upgrade', 'pi'], cwd);
  await checked('pi', ['update', '--extensions'], cwd);
}

export async function resolvePi(cwd: string) {
  console.log('Resolving Pi version, binary, and changelog');
  const version = await checked('pi', ['--version'], cwd);
  const mise = await command('mise', ['which', 'pi'], cwd);
  let binary: string | undefined;
  if (mise.code === 0) {
    binary = await realpath(mise.output.trim());
  } else {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = join(directory, 'pi');
      try {
        await access(candidate, constants.X_OK);
        binary = await realpath(candidate);
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error &&
          (error.code === 'ENOENT' || error.code === 'EACCES'))) throw error;
      }
    }
  }
  if (!binary) throw new Error('Pi binary not found on PATH');
  const changelog = join(dirname(binary), 'CHANGELOG.md');
  await access(changelog, constants.R_OK);
  return { version, binary, changelog };
}
