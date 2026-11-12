import * as core from '@actions/core';
import { parseStrict, validateDocument } from '@c2-poly/compliance-core';
import type { Api } from './api.js';
import { runGit, type GitRunner } from './git.js';
import type { LagResult, RepoRef } from './types.js';

export interface LagOptions {
  api: Api;
  /** The compliance repo, where anchors.yaml lives. */
  complianceRepo: RepoRef;
  /** Repo name without owner: the key of anchors.yaml. */
  repoName: string;
  /** The commit being synced. */
  sha: string;
  /** Root linked_files of the manifest. */
  linkedFiles: string[] | undefined;
  /** Working copy of the repo. */
  cwd: string;
  git?: GitRunner;
}

const NEVER_DOCUMENTED: LagResult = { anchor: null, count: 0, commits: [] };

const unknown = (reason: string): LagResult => ({ status: 'unknown', reason });

/** `git log <anchor>..<sha> -- <linked_files>`, where the anchor comes from anchors.yaml of the compliance repo. */
export async function computeLag(o: LagOptions): Promise<LagResult> {
  const git = o.git ?? runGit;

  const text = await o.api.getFile(o.complianceRepo, 'anchors.yaml');
  if (text === null) {
    core.info('No anchors.yaml in the compliance repo: this repo was never documented.');
    return { ...NEVER_DOCUMENTED, commits: [] };
  }
  let doc: unknown;
  try {
    doc = parseStrict(text);
  } catch {
    return warn('anchors.yaml is not valid YAML');
  }
  const problems = validateDocument('anchors', doc);
  if (problems.length > 0) return warn(`anchors.yaml is invalid (${problems[0].instancePath}: ${problems[0].message})`);

  const entry = (doc as { repos: Record<string, { sha: string }> }).repos[o.repoName];
  if (!entry) {
    core.info(`No anchor for "${o.repoName}" in anchors.yaml: this repo was never documented.`);
    return { ...NEVER_DOCUMENTED, commits: [] };
  }
  const anchor = entry.sha;

  if (!o.linkedFiles || o.linkedFiles.length === 0) {
    return warn('the manifest has no root linked_files, so the lag cannot be computed', false);
  }

  const known = await git(['cat-file', '-e', `${anchor}^{commit}`], o.cwd);
  if (known.code !== 0) {
    core.warning(
      `The anchor commit ${anchor} is not in the local history. If the checkout is shallow, use "fetch-depth: 0" in actions/checkout.`,
    );
    return unknown(`anchor ${anchor} not in the local history`);
  }
  const ancestor = await git(['merge-base', '--is-ancestor', anchor, o.sha], o.cwd);
  if (ancestor.code !== 0) {
    core.warning(`The anchor commit ${anchor} is not an ancestor of ${o.sha} (history rewritten?): the lag is unknown.`);
    return unknown(`anchor ${anchor} is not an ancestor of ${o.sha}`);
  }

  const log = await git(
    ['log', '--format=%H', `${anchor}..${o.sha}`, '--', ...o.linkedFiles.map((g) => `:(glob)${g}`)],
    o.cwd,
  );
  if (log.code !== 0) {
    core.warning(`git log failed: ${log.stderr.trim().split('\n')[0]}`);
    return unknown('git log failed');
  }
  const commits = log.stdout.split('\n').filter(Boolean);
  return { anchor, count: commits.length, commits };

  function warn(reason: string, asWarning = true): LagResult {
    if (asWarning) core.warning(`Lag unknown: ${reason}.`);
    else core.info(`Lag unknown: ${reason}.`);
    return unknown(reason);
  }
}
