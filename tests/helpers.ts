import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, type Mocked } from 'vitest';
import * as core from '@actions/core';
import type { Api } from '../src/api.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const EXAMPLE = join(FIXTURES, 'bistro-booking');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

export function tmp(prefix = 'ca-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Makes a commit changing one file; returns its SHA. */
export function commit(dir: string, path: string, content: string, message = `change ${path}`): string {
  write(dir, path, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

export function initRepo(): string {
  const dir = tmp('ca-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** A compliance repo: a copy of the Bistro Booking example, pushed to a bare remote. */
export function complianceRepo(): { dir: string; remote: string } {
  const root = tmp('ca-compliance-');
  const remote = join(root, 'remote.git');
  const dir = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  cpSync(EXAMPLE, dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  return { dir, remote };
}

/** Every string the action logged or annotated through @actions/core (core must be vi.mock-ed). */
export function logged(): string[] {
  const out: string[] = [];
  for (const fn of [core.info, core.warning, core.error, core.notice, core.debug, core.setFailed, core.setOutput]) {
    for (const call of vi.mocked(fn).mock.calls) out.push(JSON.stringify(call));
  }
  return out;
}

export function mockApi(overrides: Partial<Api> = {}): Mocked<Api> {
  return {
    getFile: vi.fn(async () => null as string | null),
    isOnDefaultBranch: vi.fn(async (..._a: unknown[]) => true),
    listPullRequestCommits: vi.fn(async (..._a: unknown[]) => [] as { sha: string; authorEmail: string | null }[]),
    dispatch: vi.fn(async (..._a: unknown[]) => undefined),
    findOpenPullRequest: vi.fn(async (..._a: unknown[]) => null as { number: number; url: string } | null),
    createPullRequest: vi.fn(async (..._a: unknown[]) => ({ number: 1, url: 'https://github.com/bistro-org/bistro-compliance/pull/1' })),
    updatePullRequest: vi.fn(async (_r: unknown, number: number, ..._a: unknown[]) => ({ number, url: `https://github.com/bistro-org/bistro-compliance/pull/${number}` })),
    ...overrides,
  } as unknown as Mocked<Api>;
}
