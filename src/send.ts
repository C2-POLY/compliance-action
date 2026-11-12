import * as core from '@actions/core';
import { parseStrict } from '@c2-poly/compliance-core';
import { explainGitHubError, type Api } from './api.js';
import { loadAndValidateManifest } from './check.js';
import { ActionError } from './errors.js';
import { runGit, type GitRunner } from './git.js';
import { computeLag } from './lag.js';
import { lagCount, lagStatus, type EventContext, type Lag, type LagResult, type RepoRef } from './types.js';

export const EVENT_TYPE = 'compliance-manifest';
/** GitHub caps client_payload at 65,535 characters; the manifest gets most of it. */
export const MAX_MANIFEST_BYTES = 60 * 1024;

export interface SendOptions {
  manifestPath: string;
  complianceRepo: string;
  baseBranch: string;
  ctx: EventContext;
  api: Api;
  cwd: string;
  git?: GitRunner;
}

export function parseRepoRef(value: string, what: string): RepoRef {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!m) throw new ActionError(`${what} must be "owner/name", got "${value}".`);
  return { owner: m[1], repo: m[2] };
}

export async function runSend(o: SendOptions): Promise<void> {
  const { ctx } = o;
  if (ctx.eventName !== 'push' || ctx.ref !== `refs/heads/${o.baseBranch}`) {
    core.info(`Skipped: mode send only runs on a push to "${o.baseBranch}" (event: ${ctx.eventName}, ref: ${ctx.ref}).`);
    return;
  }
  const target = parseRepoRef(o.complianceRepo, 'compliance-repo');

  const text = loadAndValidateManifest(o.manifestPath);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_MANIFEST_BYTES) {
    throw new ActionError(
      `The manifest is ${size} bytes, over the ${MAX_MANIFEST_BYTES} bytes a repository_dispatch payload can carry. Shorten it.`,
    );
  }

  const manifest = parseStrict(text) as { linked_files?: string[] };
  const lagResult = await computeLag({
    api: o.api,
    complianceRepo: target,
    repoName: ctx.repo.repo,
    sha: ctx.sha,
    linkedFiles: manifest.linked_files,
    cwd: o.cwd,
    git: o.git ?? runGit,
  }).catch((err: unknown): LagResult => {
    const status = (err as { status?: number }).status;
    return { status: 'unknown', reason: `anchors.yaml could not be read${status ? ` (HTTP ${status})` : ''}` };
  });
  // The reason only goes to the logs: the format has no field for it.
  const { reason, ...lag } = lagResult as Lag & { reason?: string };
  if (reason) core.info(`lag unknown: ${reason}`);
  core.setOutput('lag-count', lagCount(lag));
  core.setOutput('lag-status', lagStatus(lag));

  try {
    await o.api.dispatch(target, EVENT_TYPE, {
      repo: `${ctx.repo.owner}/${ctx.repo.repo}`,
      sha: ctx.sha,
      manifest: text,
      lag,
    });
  } catch (err) {
    throw new ActionError(explainGitHubError(err, `Sending the manifest to ${o.complianceRepo}`));
  }
  core.info(`Manifest of ${ctx.repo.owner}/${ctx.repo.repo}@${ctx.sha.slice(0, 7)} sent to ${o.complianceRepo} (lag: ${lagStatus(lag)}, ${lagCount(lag)} commit(s)).`);
}
