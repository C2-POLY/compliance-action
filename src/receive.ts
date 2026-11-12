import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as core from '@actions/core';
import { validateDocument, validateText, versionOf, type SpecVersion } from '@c2-poly/compliance-core';
import { stringify } from 'yaml';
import type { Api } from './api.js';
import { BOT_EMAIL, BOT_NAME, assertNoSymlink, commitPushAndOpenPr, guardBotBranch, remoteAuthEnv, writeNoFollow } from './bot.js';
import { ActionError } from './errors.js';
import { mustGit, runGit, type GitRunner } from './git.js';
import { EVENT_TYPE, parseRepoRef } from './send.js';
import type { EventContext, Lag } from './types.js';
import { lagCount, lagStatus } from './types.js';

export { BOT_EMAIL, BOT_NAME };
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface ReceiveOptions {
  compliancePath: string;
  baseBranch: string;
  /** Path of the manifest in the sender repo, fetched to verify the payload. */
  manifestPath: string;
  /** Used for the git remote operations (never in argv) and, with verifySource, to read the sender repo. */
  token: string;
  /** Check the payload against the sender repo before writing anything. */
  verifySource: boolean;
  ctx: EventContext;
  api: Api;
  git?: GitRunner;
  now?: () => Date;
}

interface Received {
  repo: string;
  name: string;
  owner: string;
  sha: string;
  manifest: string;
  lag: Lag;
}

function readPayload(ctx: EventContext): Received {
  if (ctx.eventName !== 'repository_dispatch' || ctx.payload.action !== EVENT_TYPE) {
    throw new ActionError(`mode receive runs on a repository_dispatch event of type "${EVENT_TYPE}" (got: ${ctx.eventName}${ctx.payload.action ? `/${ctx.payload.action}` : ''}).`);
  }
  const p = ctx.payload.client_payload ?? {};
  if (typeof p.repo !== 'string') throw new ActionError('The payload has no "repo".');
  const { owner, repo: name } = parseRepoRef(p.repo, 'payload.repo');
  if (!NAME_RE.test(name) || name === '.' || name === '..') throw new ActionError(`Refused: "${name}" is not a valid repo name.`);
  if (typeof p.sha !== 'string' || !/^[0-9a-f]{40}$/.test(p.sha)) throw new ActionError('The payload "sha" is not a 40-character commit SHA.');
  if (typeof p.manifest !== 'string' || p.manifest.length === 0) throw new ActionError('The payload has no "manifest" text.');
  if (typeof p.lag !== 'object' || p.lag === null) throw new ActionError('The payload has no "lag".');
  return { repo: p.repo, name, owner, sha: p.sha, manifest: p.manifest, lag: p.lag };
}

/** Checks that the sender is listed; returns the spec_version of compliance.yaml. */
function assertListed(compliancePath: string, r: Received): SpecVersion {
  let text: string;
  try {
    text = readFileSync(join(compliancePath, 'compliance.yaml'), 'utf8');
  } catch {
    throw new ActionError(`compliance.yaml not found in "${compliancePath}". Is the compliance repo checked out?`);
  }
  const { doc, errors } = validateText('compliance', text);
  if (errors.length > 0) throw new ActionError(`compliance.yaml is invalid: ${errors[0].instancePath}: ${errors[0].message}`);
  const repos = (doc as { repos: { name: string; url: string }[] }).repos;
  const entry = repos.find((x) => x.name === r.name);
  if (!entry) throw new ActionError(`Repo "${r.repo}" is not listed in compliance.yaml. Add it there first.`);
  // Fail closed: the listed URL must be exactly https://github.com/<owner>/<name>.
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(entry.url);
  if (!m) throw new ActionError(`The URL listed for "${r.name}" in compliance.yaml is not https://github.com/<owner>/<name>: refusing to receive.`);
  if (m[1].toLowerCase() !== r.owner.toLowerCase() || m[2].toLowerCase() !== r.name.toLowerCase()) {
    throw new ActionError(`Repo "${r.repo}" does not match the URL listed in compliance.yaml (${entry.url}).`);
  }
  return versionOf(doc);
}

/** The payload is only a claim: check it against the sender repo. */
async function verifySource(o: ReceiveOptions, r: Received): Promise<void> {
  const sender = { owner: r.owner, repo: r.name };
  try {
    const source = await o.api.getFile(sender, o.manifestPath, r.sha);
    if (source === null) throw new ActionError(`Source check failed: ${o.manifestPath} does not exist in ${r.repo} at ${r.sha}. Nothing was written.`);
    if (source !== r.manifest) throw new ActionError(`Source check failed: the manifest sent differs from ${o.manifestPath} in ${r.repo} at ${r.sha}. Nothing was written.`);
    if (!(await o.api.isOnDefaultBranch(sender, r.sha))) {
      throw new ActionError(`Source check failed: commit ${r.sha} is not on the default branch of ${r.repo}. Nothing was written.`);
    }
  } catch (err) {
    if (err instanceof ActionError) throw err;
    const status = (err as { status?: number }).status;
    throw new ActionError(`Source check failed: could not read ${r.repo}${status ? ` (HTTP ${status})` : ''}. The receive token needs Contents: read on the service repos, or set verify-source to false.`);
  }
}

export async function runReceive(o: ReceiveOptions): Promise<void> {
  const git = o.git ?? runGit;
  const root = resolve(o.compliancePath);
  const r = readPayload(o.ctx);
  const repoVersion = assertListed(root, r);

  const { doc: manifestDoc, errors } = validateText('manifest', r.manifest);
  if (errors.length > 0) {
    for (const e of errors) core.error(`${e.instancePath}: ${e.message}`, { title: `Invalid manifest received from ${r.repo}` });
    throw new ActionError(`The manifest received from ${r.repo} is invalid: ${errors.length} error(s). Nothing was written.`);
  }
  if (repoVersion === '0.1' && versionOf(manifestDoc) !== '0.1') {
    throw new ActionError(`The manifest received from ${r.repo} is spec_version "${versionOf(manifestDoc)}" but compliance.yaml is "0.1": its v0.2 fields would be ignored. Upgrade compliance.yaml to "0.2". Nothing was written.`);
  }
  const declared = (manifestDoc as { service: { repo?: string } }).service.repo;
  if (declared !== undefined && declared.toLowerCase() !== r.repo.toLowerCase()) {
    throw new ActionError(`The manifest says service.repo is "${declared}" but it was sent by "${r.repo}". Nothing was written.`);
  }

  if (o.verifySource) {
    await verifySource(o, r);
    core.info('Source verified: the payload matches the sender repo.');
  } else {
    core.warning('verify-source is false: the payload was not checked against the sender repo.');
  }

  const { reason: _reason, ...lag } = r.lag as Lag & { reason?: string };
  // sync.yaml has the same shape in both versions: it takes the version of the compliance repo.
  const sync = {
    spec_version: repoVersion,
    repo: r.name,
    sha: r.sha,
    received_at: (o.now ?? (() => new Date()))().toISOString(),
    lag,
  };
  const syncErrors = validateDocument('sync', sync);
  if (syncErrors.length > 0) throw new ActionError(`The payload does not make a valid sync record: ${syncErrors[0].instancePath}: ${syncErrors[0].message}. Nothing was written.`);

  // The only place the action writes: services/<name>/.
  const servicesDir = join(root, 'services');
  const dir = resolve(servicesDir, r.name);
  const rel = relative(servicesDir, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel !== r.name) {
    throw new ActionError(`Refused: "${r.name}" resolves outside services/.`);
  }

  const branch = `compliance/${r.name}`;
  const short = r.sha.slice(0, 7);
  const base = o.baseBranch;
  const repo = o.ctx.repo;

  const remoteEnv = remoteAuthEnv(o.token);
  const { existing, remoteSha } = await guardBotBranch({ git, api: o.api, root, repo, branch, base, remoteEnv });

  await mustGit(git, ['checkout', '-B', branch, `origin/${base}`], root);

  assertNoSymlink(root, 'services');
  assertNoSymlink(root, 'services', r.name);
  for (const f of ['manifest.yaml', 'sync.yaml']) assertNoSymlink(root, 'services', r.name, f);
  mkdirSync(dir, { recursive: true });
  writeNoFollow(join(dir, 'manifest.yaml'), r.manifest);
  writeNoFollow(join(dir, 'sync.yaml'), stringify(sync));

  await mustGit(git, ['add', '--', `services/${r.name}/manifest.yaml`, `services/${r.name}/sync.yaml`], root);
  const staged = await git(['diff', '--cached', '--quiet'], root);
  if (staged.code === 0) {
    core.notice(`services/${r.name}/ is already up to date with origin/${base}: nothing to commit.`);
    return;
  }
  const title = `compliance: update ${r.name} to ${short}`;
  const body = [
    `Manifest of \`${r.repo}\` received at commit \`${r.sha}\`.`,
    '',
    o.verifySource
      ? `- Source verified: the manifest is identical to \`${o.manifestPath}\` of \`${r.repo}\` at that commit, and the commit is on its default branch.`
      : '- **Source not verified** (`verify-source: false`): the payload was not checked against the service repo.',
    `- Documents lag (reported by the service repo): ${lagStatus(lag)}${'status' in lag ? '' : `, ${lagCount(lag)} commit(s) since the last generated documents`}`,
    '',
    'Review and merge to validate. Written by compliance-action; do not edit `services/` by hand.',
  ].join('\n');
  await commitPushAndOpenPr({ git, api: o.api, root, repo, branch, base, remoteEnv, existing, remoteSha, title, body });
}
