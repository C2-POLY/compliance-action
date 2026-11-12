import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as core from '@actions/core';
import {
  LANGUAGES,
  REGISTER_VERSION,
  actionLabel,
  actionsSummary,
  anchorsYaml,
  buildDossier,
  buildRegister,
  codeSpan,
  dossierLanguage,
  openSummary,
  parseStrict,
  readDoc,
  roleLabel,
  validateDocument,
  versionOf,
  type ComplianceTree,
  type Language,
  type SpecVersion,
} from '@c2-poly/compliance-core';
import { loadDirectory } from '@c2-poly/compliance-core/fs';
import type { Api } from './api.js';
import { BOT_EMAIL, BOT_NAME, assertNoSymlink, commitPushAndOpenPr, guardBotBranch, remoteAuthEnv, writeNoFollow } from './bot.js';
import { ActionError } from './errors.js';
import { mustGit, runGit, type GitRunner } from './git.js';
import type { EventContext } from './types.js';

// The register and the dossier are built by @c2-poly/compliance-core. This module is the register mode only:
// checkout of the bot branch, idempotence, language, writing the files and the pull request.

export { BOT_EMAIL, BOT_NAME };

export const REGISTER_BRANCH = 'compliance/register';
export const REGISTER_TITLE = 'compliance: update the records of processing';

/** generated_at of the anchors.yaml already on the base branch, or null when there is none or it cannot be read. */
function previousGeneratedAt(root: string): string | null {
  const path = join(root, 'anchors.yaml');
  if (!existsSync(path)) return null;
  try {
    const doc = parseStrict(readFileSync(path, 'utf8'));
    if (validateDocument('anchors', doc).length > 0) return null;
    return (doc as { generated_at: string }).generated_at;
  } catch {
    return null;
  }
}

interface Generated {
  markdown: string;
  anchors: Record<string, string>;
  specVersion: SpecVersion;
  /** The lines of the pull request body that list what is open. */
  openLines: string[];
  /** The first sentence of the pull request body. */
  what: string;
  /** The sentence of the pull request body that explains the open items. */
  howToRead: string;
}

/** The document of the compliance repo's version: the v0.1 register, or the v0.2 dossier in `language`. */
function generate(tree: ComplianceTree, generatedAt: string, language: Language): Generated {
  const compliance = readDoc(tree, 'compliance.yaml', 'compliance');
  if (versionOf(compliance) === REGISTER_VERSION) {
    const { markdown, anchors, open } = buildRegister(tree, generatedAt);
    return {
      markdown,
      anchors,
      specVersion: REGISTER_VERSION,
      what: 'Records of processing activities (GDPR Art. 30(1)) generated from the compliance repo.',
      openLines: [
        `- Open items: ${openSummary(open.reduce((n, x) => n + x.items.length, 0), open.filter((x) => x.items.length > 0).length, open.length)}`,
        ...open.filter((x) => x.items.length > 0).map((x) => `  - ${codeSpan(`${x.name} (${x.id})`)}: ${x.items.map(codeSpan).join(', ')}`),
      ],
      howToRead: 'Open items are listed first in the register: rows marked `To complete` have no source and need a person, and joint controller and representative are always to confirm by hand.',
    };
  }
  const d = buildDossier(tree, generatedAt, language);
  return {
    markdown: d.markdown,
    anchors: d.anchors,
    specVersion: '0.2',
    what: `Compliance dossier (organisation, actions, records of processing under GDPR Art. 30(1), DPO checks, AI features) generated from the compliance repo, in ${language === 'fr' ? 'French' : 'English'}.`,
    // The pull request body is in English, whatever the language of the dossier.
    openLines: [
      `- Open items: ${actionsSummary(d.openItems, d.actions.length, 'en')}`,
      ...d.actions.map((a) => `  - ${codeSpan(a.id)}: ${codeSpan(actionLabel(a.id, 'en'))} (${codeSpan(roleLabel(a.role, 'en'))}, ${a.count})`),
    ],
    howToRead: 'The actions that close the open items are listed first in the dossier: rows marked `To complete` have no source and need a person.',
  };
}

/** True when regenerating with the previous generated_at gives the files already there, byte for byte. */
function isUpToDate(root: string, tree: ComplianceTree, previous: string, language: Language): boolean {
  const registerPath = join(root, 'documents', 'register.md');
  if (!existsSync(registerPath)) return false;
  // previous passed the anchors schema, so the build only fails on what the regular build fails on.
  const same = generate(tree, previous, language);
  return (
    readFileSync(registerPath, 'utf8') === same.markdown &&
    readFileSync(join(root, 'anchors.yaml'), 'utf8') === anchorsYaml(same.anchors, previous, same.specVersion)
  );
}

// ---------- the mode ----------

export interface RegisterOptions {
  compliancePath: string;
  baseBranch: string;
  token: string;
  /** RFC 3339. Default: the commit time of HEAD of the compliance repo, so that reruns give the same bytes. */
  generatedAt?: string;
  /** Language of the v0.2 dossier, `en` or `fr`. When absent: organisation.language of compliance.yaml, else `en`. A v0.1 register is always in English. */
  language?: string;
  ctx: EventContext;
  api: Api;
  git?: GitRunner;
}

export async function runRegister(o: RegisterOptions): Promise<void> {
  const git = o.git ?? runGit;
  const root = resolve(o.compliancePath);
  const branch = REGISTER_BRANCH;
  const base = o.baseBranch;
  const repo = o.ctx.repo;
  if (o.language && !LANGUAGES.includes(o.language as Language)) throw new ActionError(`Unknown language "${o.language}". Use ${LANGUAGES.join(' or ')}.`);

  const remoteEnv = remoteAuthEnv(o.token);
  const { existing, remoteSha } = await guardBotBranch({ git, api: o.api, root, repo, branch, base, remoteEnv });
  await mustGit(git, ['checkout', '-B', branch, `origin/${base}`], root);

  assertNoSymlink(root, 'documents');
  assertNoSymlink(root, 'documents', 'register.md');
  assertNoSymlink(root, 'anchors.yaml');
  // Everything the engine reads, with the symlink and strict-YAML rules of the action.
  const tree = loadDirectory(root);
  const language = dossierLanguage(tree, o.language);

  // A commit that changes nothing in the register (a receive with no processing using it)
  // must not open a pull request whose only change is generated_at.
  const previous = previousGeneratedAt(root);
  if (previous && isUpToDate(root, tree, previous, language)) {
    core.notice(`The register and anchors.yaml are already up to date with origin/${base}: nothing to commit.`);
    return;
  }

  const generatedAt = o.generatedAt || (await mustGit(git, ['log', '-1', '--format=%cI'], root));
  const { markdown, anchors, specVersion, what, openLines, howToRead } = generate(tree, generatedAt, language);
  if (specVersion === REGISTER_VERSION && language !== 'en') core.info(`compliance.yaml is spec_version "${REGISTER_VERSION}": the register is in English, language "${language}" applies to a v0.2 dossier only.`);

  mkdirSync(join(root, 'documents'), { recursive: true });
  writeNoFollow(join(root, 'documents', 'register.md'), markdown);
  writeNoFollow(join(root, 'anchors.yaml'), anchorsYaml(anchors, generatedAt, specVersion));

  await mustGit(git, ['add', '--', 'documents/register.md', 'anchors.yaml'], root);
  const staged = await git(['diff', '--cached', '--quiet'], root);
  if (staged.code === 0) {
    core.notice(`The register and anchors.yaml are already up to date with origin/${base}: nothing to commit.`);
    return;
  }

  const body = [
    what,
    '',
    `- Generated at: \`${generatedAt}\``,
    `- Repos documented: ${Object.keys(anchors).length > 0 ? Object.entries(anchors).map(([r, sha]) => `\`${r}\` at \`${sha.slice(0, 7)}\``).join(', ') : 'none'}`,
    ...openLines,
    '',
    `This document is prepared for review by the controller and its data protection officer. It does not certify compliance with the GDPR${specVersion === REGISTER_VERSION ? '' : ' or the AI Act'}. ${howToRead}`,
    '',
    'Merging this pull request records `anchors.yaml`: the lag of each service then restarts from 0. Written by compliance-action; do not edit `documents/register.md` or `anchors.yaml` by hand.',
  ].join('\n');
  await commitPushAndOpenPr({ git, api: o.api, root, repo, branch, base, remoteEnv, existing, remoteSha, title: REGISTER_TITLE, body });
}
