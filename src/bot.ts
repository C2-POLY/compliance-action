import { closeSync, constants, lstatSync, openSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as core from '@actions/core';
import { explainGitHubError, type Api, type PullRequest } from './api.js';
import { ActionError } from './errors.js';
import { mustGit, type GitRunner } from './git.js';
import type { RepoRef } from './types.js';

/** What the modes that open a bot pull request (receive, register) have in common. */

export const BOT_NAME = 'compliance-action';
export const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/** Refuses a symlink anywhere on the way to a file we are about to read or write. */
export function assertNoSymlink(root: string, ...parts: string[]): void {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (stat.isSymbolicLink()) throw new ActionError(`Refused: ${relative(root, current)} is a symbolic link.`);
  }
}

export function writeNoFollow(path: string, data: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Remote operations authenticate with the token through the environment of git, never through argv. */
export function remoteAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  core.setSecret(basic);
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export interface BotBranch {
  git: GitRunner;
  api: Api;
  root: string;
  repo: RepoRef;
  branch: string;
  base: string;
  remoteEnv: Record<string, string>;
}

/** Fetches the base, and refuses to go on when a human edited the open pull request of the bot branch. */
export async function guardBotBranch(b: BotBranch): Promise<{ existing: PullRequest | null; remoteSha: string }> {
  await mustGit(b.git, ['fetch', '--no-tags', 'origin', b.base], b.root, b.remoteEnv);
  const remote = await mustGit(b.git, ['ls-remote', '--heads', 'origin', `refs/heads/${b.branch}`], b.root, b.remoteEnv);
  const remoteSha = remote.split(/\s+/)[0] ?? '';

  // A human may have edited the bot branch: do not overwrite their work.
  const existing = await b.api.findOpenPullRequest(b.repo, b.branch, b.base).catch((err: unknown) => {
    throw new ActionError(explainGitHubError(err, 'Looking for the open pull request'));
  });
  if (existing) {
    const commits = await b.api.listPullRequestCommits(b.repo, existing.number).catch((err: unknown) => {
      throw new ActionError(explainGitHubError(err, `Reading pull request #${existing.number}`));
    });
    const foreign = commits.filter((c) => c.authorEmail !== BOT_EMAIL);
    if (foreign.length > 0) {
      throw new ActionError(`Refused: ${b.branch} has commits not authored by ${BOT_NAME} (${foreign.map((c) => c.sha.slice(0, 7)).join(', ')}): a human edited the branch of pull request #${existing.number}. Merge or close it first.`);
    }
    if (commits.length > 0 && remoteSha && commits[commits.length - 1].sha !== remoteSha) {
      throw new ActionError(`Refused: ${b.branch} changed while it was being checked. Run again.`);
    }
  }
  return { existing, remoteSha };
}

/** Commits as the bot, pushes the bot branch only (force-with-lease on the sha read earlier) and opens or updates the pull request. */
export async function commitPushAndOpenPr(
  b: BotBranch & { existing: PullRequest | null; remoteSha: string; title: string; body: string },
): Promise<void> {
  await mustGit(
    b.git,
    ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '--quiet', '-m', b.title],
    b.root,
  );
  await mustGit(
    b.git,
    ['push', `--force-with-lease=refs/heads/${b.branch}:${b.remoteSha}`, 'origin', `HEAD:refs/heads/${b.branch}`],
    b.root,
    b.remoteEnv,
  );
  try {
    if (b.existing) {
      await b.api.updatePullRequest(b.repo, b.existing.number, { title: b.title, body: b.body });
      core.info(`Updated pull request #${b.existing.number}: ${b.existing.url}`);
    } else {
      const created = await b.api.createPullRequest(b.repo, { head: b.branch, base: b.base, title: b.title, body: b.body });
      core.info(`Opened pull request #${created.number}: ${created.url}`);
    }
  } catch (err) {
    throw new ActionError(explainGitHubError(err, 'Opening the pull request'));
  }
}
