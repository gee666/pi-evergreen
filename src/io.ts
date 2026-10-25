import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';

export async function readOptional(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, 'utf8') : undefined;
}

export async function command(
  program: string,
  args: string[],
  cwd: string,
  env = process.env,
  logPath?: string,
): Promise<{ code: number; output: string }> {
  const log = logPath ? await open(logPath, 'a') : undefined;
  try {
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      let output = '';
      // Ignoring stdin opens /dev/null, including for every Pi invocation.
      const child = spawn(program, args, {
        cwd, env, stdio: ['ignore', log?.fd ?? 'pipe', log?.fd ?? 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.on('error', (error) => {
        output += `${error.message}\n`;
      });
      child.on('close', (code, signal) => {
        if (signal) output += `Terminated by ${signal}\n`;
        resolve({ code: code ?? 1, output });
      });
    });
    if (log && result.output) await log.write(result.output);
    return result;
  } finally {
    await log?.close();
  }
}

export async function checked(program: string, args: string[], cwd: string): Promise<string> {
  const result = await command(program, args, cwd);
  if (result.output.trim()) console.log(result.output.trim());
  if (result.code !== 0) throw new Error(`${program} ${args.join(' ')} exited ${result.code}`);
  return result.output.trim();
}
