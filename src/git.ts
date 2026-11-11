import { execFile } from 'node:child_process';
import { ActionError } from './errors.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd`. Never throws on a non-zero exit. */
export type GitRunner = (args: string[], cwd: string, env?: Record<string, string>) => Promise<GitResult>;

export const runGit: GitRunner = (args, cwd, env) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: error && typeof error.code !== 'number' ? error.message : stderr });
    });
  });

/** Runs git and throws an ActionError on failure. Returns trimmed stdout. */
export async function mustGit(run: GitRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const r = await run(args, cwd, env);
  if (r.code !== 0) {
    throw new ActionError(`git ${args[0]} failed: ${r.stderr.trim().split('\n')[0] || `exit code ${r.code}`}`);
  }
  return r.stdout.trim();
}
