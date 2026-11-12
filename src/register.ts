import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as core from '@actions/core';
import { stringify } from 'yaml';
import type { Api } from './api.js';
import { BOT_EMAIL, BOT_NAME, assertNoSymlink, commitPushAndOpenPr, guardBotBranch, remoteAuthEnv, writeNoFollow } from './bot.js';
import { ActionError } from './errors.js';
import { mustGit, runGit, type GitRunner } from './git.js';
import { parseStrict } from './yaml.js';
import { SPEC_VERSION, validateDocument, validateText, type SchemaName } from './schema.js';
import type { EventContext } from './types.js';

export { BOT_EMAIL, BOT_NAME };

export const REGISTER_BRANCH = 'compliance/register';
export const REGISTER_TITLE = 'compliance: update the records of processing';
const TEMPLATE_URL = new URL('../templates/register/register.md.tmpl', import.meta.url);

// EU/EEA country codes, fixed by version 0.1 of the template (templates/register/README.md).
const EU_EEA = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IS IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE'.split(' '));

const TO_COMPLETE = 'To complete';
const NONE_IDENTIFIED = 'None identified in the sources';
const NO_SOURCE = '—';
/** Always To complete in v0.1 (no field in the processing format): never an open item. */
const NOT_COUNTED = new Set(['(a) Joint controller', '(a) Representative']);

/** A required text a person wrote as "to complete" is a gap, not a value. */
const isPlaceholder = (value: string): boolean => /^to complete$/i.test(value.trim());
const filled = (value: string): string => (isPlaceholder(value) ? TO_COMPLETE : value);

/** Free text as an inline code span on one line: no markdown, no @mention, no line break. */
export function codeSpan(value: string): string {
  return `\`${value.replace(/\r\n|\r|\n/g, ' ').replace(/`/g, "'").trim()}\``;
}

/** The summary line of the open items. */
export function openSummary(count: number, withOpen: number, total: number): string {
  const activities = total === 1 ? 'processing activity' : 'processing activities';
  if (total === 0) return 'No processing activity yet.';
  if (count === 0) return `No open item in the ${total} ${activities}.`;
  return `${count} open ${count === 1 ? 'item' : 'items'} in ${withOpen} of the ${total} ${activities}.`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;
type Src = { kind: 'code' | 'spec' | 'declared'; ref: string };

// ---------- template renderer ----------

type Value = string | Context[];
interface Context {
  [name: string]: Value;
}

type Node = { text: string } | { each: string; body: Node[] };

function parseTemplate(template: string): Node[] {
  const lines = template.split('\n');
  // The last element is the empty string after the final newline.
  const last = lines.pop();
  const root: Node[] = [];
  const stack: { each: string; body: Node[] }[] = [];
  const current = () => (stack.length ? stack[stack.length - 1].body : root);
  for (const line of lines) {
    const open = /^\{\{#each (\w+)\}\}$/.exec(line.trim());
    if (open) {
      const block = { each: open[1], body: [] as Node[] };
      current().push(block);
      stack.push(block);
    } else if (line.trim() === '{{/each}}') {
      if (!stack.pop()) throw new ActionError('Template error: {{/each}} without {{#each}}.');
    } else {
      if (/\{\{[#/]/.test(line)) throw new ActionError(`Template error: a block tag must be alone on its line: ${line}`);
      current().push({ text: `${line}\n` });
    }
  }
  if (stack.length > 0) throw new ActionError(`Template error: {{#each ${stack[stack.length - 1].each}}} is not closed.`);
  if (last) current().push({ text: last });
  return root;
}

function lookup(scopes: Context[], name: string): Value {
  for (let i = scopes.length - 1; i >= 0; i--) if (name in scopes[i]) return scopes[i][name];
  throw new ActionError(`Template error: "${name}" is not in the context.`);
}

function renderLine(line: string, scopes: Context[]): string {
  let out = '';
  let from = 0;
  for (const m of line.matchAll(/\{\{(\w+)\}\}/g)) {
    const value = lookup(scopes, m[1]);
    if (typeof value !== 'string') throw new ActionError(`Template error: "${m[1]}" is a list, not a text.`);
    out += line.slice(from, m.index);
    from = m.index + m[0].length;
    // An empty value in a table cell (`| {{item}} |`) leaves `| |`, not `|  |`.
    if (value === '' && out.endsWith(' ') && line[from] === ' ') out = out.slice(0, -1);
    out += value;
  }
  return out + line.slice(from);
}

function renderNodes(nodes: Node[], scopes: Context[]): string {
  let out = '';
  for (const node of nodes) {
    if ('text' in node) {
      out += renderLine(node.text, scopes);
    } else {
      const list = lookup(scopes, node.each);
      if (typeof list === 'string') throw new ActionError(`Template error: "${node.each}" is a text, not a list.`);
      for (const item of list) out += renderNodes(node.body, [...scopes, item]);
    }
  }
  return out;
}

/** {{name}}, {{#each name}}...{{/each}}; a line holding only a block tag is removed with its newline. */
export function renderTemplate(template: string, root: Context): string {
  return `${renderNodes(parseTemplate(template), [root]).replace(/\n+$/, '')}\n`;
}

// ---------- helpers ----------

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One line, trimmed, `|` escaped. */
function cell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|').trim();
}

const SOURCE_RANK: Record<string, number> = { code: 0, spec: 1, declared: 2 };
const sourceRank = (source: string): number => SOURCE_RANK[source.slice(0, source.indexOf(':'))] ?? 3;

interface Cand {
  value: string;
  source: string;
}

/** One row per value; the source is the strongest (kind, then ascending string). Sorted by value. */
function atomic(cands: Cand[]): Cand[] {
  const best = new Map<string, string>();
  for (const c of cands) {
    const had = best.get(c.value);
    if (had === undefined || sourceRank(c.source) < sourceRank(had) || (sourceRank(c.source) === sourceRank(had) && c.source < had)) {
      best.set(c.value, c.source);
    }
  }
  return [...best].map(([value, source]) => ({ value, source })).sort((a, b) => cmp(a.value, b.value));
}

/** Composite values: sorted by value then source; the same value from the same source is one row. */
function composite(cands: Cand[]): Cand[] {
  const seen = new Set<string>();
  return cands
    .filter((c) => {
      const key = `${c.value}\u0000${c.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => cmp(a.value, b.value) || cmp(a.source, b.source));
}

/** A value of processing.yaml: a processing file has no sync, so `code` is written as `declared`. */
function processingSource(source: Src): string {
  return source.kind === 'spec' ? `spec: ${source.ref}` : `declared: ${source.ref}`;
}

const duration = (r: { duration: string; trigger?: string }): string => (r.trigger ? `${r.duration}, ${r.trigger}` : r.duration);
const country = (c: string): string => (c === 'unknown' ? 'country unknown' : c);

// ---------- loading ----------

interface Manifest {
  /** services/<repo>/manifest.yaml or declared/<tool>/manifest.yaml */
  file: string;
  /** Folder name under services/, absent for a declared tool. */
  repo?: string;
  sha7?: string;
  sha?: string;
  doc: Doc;
}

function readDoc(root: string, rel: string, schema: SchemaName): Doc {
  const parts = rel.split('/');
  assertNoSymlink(root, ...parts);
  let text: string;
  try {
    text = readFileSync(join(root, ...parts), 'utf8');
  } catch {
    throw new ActionError(`${rel} not found (or not readable). Nothing was generated.`);
  }
  const { doc, errors } = validateText(schema, text);
  if (errors.length > 0) throw new ActionError(`${rel} is invalid: ${errors[0].instancePath}: ${errors[0].message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}. Nothing was generated.`);
  return doc as Doc;
}

function listDirs(root: string, rel: string): string[] {
  assertNoSymlink(root, rel);
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(cmp);
}

export interface Register {
  markdown: string;
  /** Repo name to the full sha of its sync.yaml, sorted by repo name. */
  anchors: Record<string, string>;
  /** The open items of each processing, in the order of the sections. */
  open: { id: string; name: string; items: string[] }[];
}

/** Builds the register from a checkout of the compliance repo. Pure: reads files, never the clock. */
export function buildRegister(complianceDir: string, generatedAt: string): Register {
  const root = resolve(complianceDir);
  const compliance = readDoc(root, 'compliance.yaml', 'compliance');

  const manifests = new Map<string, Manifest>();
  const load = (repo: string | undefined, tool: string | undefined, who: string): Manifest => {
    let file: string;
    if (repo !== undefined) {
      if (!(compliance.repos as Doc[]).some((r) => r.name === repo)) throw new ActionError(`${who}: repo "${repo}" is not listed in compliance.yaml.`);
      file = `services/${repo}/manifest.yaml`;
    } else {
      const entry = (compliance.declared_tools as Doc[] | undefined)?.find((t) => t.id === tool);
      if (!entry) throw new ActionError(`${who}: tool "${tool}" is not listed in declared_tools of compliance.yaml.`);
      file = entry.path;
    }
    const known = manifests.get(file);
    if (known) return known;
    const doc = readDoc(root, file, 'manifest');
    const m: Manifest = { file, doc };
    if (repo !== undefined) {
      const sync = readDoc(root, `services/${repo}/sync.yaml`, 'sync');
      Object.assign(m, { repo, sha: sync.sha as string, sha7: (sync.sha as string).slice(0, 7) });
    }
    manifests.set(file, m);
    return m;
  };

  // Processings, sorted by id.
  const processings: Doc[] = listDirs(root, 'processings')
    .filter((d) => existsSync(join(root, 'processings', d, 'processing.yaml')))
    .map((d) => readDoc(root, `processings/${d}/processing.yaml`, 'processing'))
    .sort((a, b) => cmp(a.id, b.id));
  for (let i = 1; i < processings.length; i++) {
    if (processings[i].id === processings[i - 1].id) throw new ActionError(`Two processings have the id "${processings[i].id}".`);
  }

  // Resolve every entry first: an unresolved reference fails before anything is built.
  const resolved = new Map<Doc, { entry: Doc; m: Manifest; scope: Set<string>; recipients?: Set<string> }[]>();
  for (const p of processings) {
    const who = `processings/${p.id}`;
    const list = (p.services as Doc[]).map((entry) => {
      const m = load(entry.repo, entry.tool, who);
      const ids = new Set<string>((m.doc.personal_data as Doc[]).map((d) => d.id));
      for (const id of (entry.data as string[] | undefined) ?? []) {
        if (!ids.has(id)) throw new ActionError(`${who}: no personal_data "${id}" in ${m.file}.`);
      }
      const recipientIds = new Set<string>([...m.doc.processors, ...m.doc.outbound_flows].map((x: Doc) => x.id));
      for (const id of (entry.recipients as string[] | undefined) ?? []) {
        if (!recipientIds.has(id)) throw new ActionError(`${who}: no processor or outbound flow "${id}" in ${m.file}.`);
      }
      return {
        entry,
        m,
        scope: entry.data ? new Set<string>(entry.data) : ids,
        recipients: entry.recipients ? new Set<string>(entry.recipients) : undefined,
      };
    });
    resolved.set(p, list);
  }

  // Names of the services of the information system: a flow to one of them is not a recipient.
  const inside = new Set<string>();
  for (const r of compliance.repos as Doc[]) {
    if (existsSync(join(root, 'services', r.name, 'manifest.yaml'))) inside.add(load(r.name, undefined, 'compliance.yaml').doc.service.name);
  }
  for (const t of (compliance.declared_tools as Doc[] | undefined) ?? []) {
    if (existsSync(join(root, t.path))) inside.add(load(undefined, t.id, 'compliance.yaml').doc.service.name);
  }

  const anchors: Record<string, string> = {};
  for (const list of resolved.values()) {
    for (const { m } of list) if (m.repo !== undefined) anchors[m.repo] = m.sha!;
  }
  const sortedAnchors = Object.fromEntries(Object.entries(anchors).sort(([a], [b]) => cmp(a, b)));
  const check = validateDocument('anchors', { spec_version: SPEC_VERSION, generated_at: generatedAt, repos: Object.fromEntries(Object.entries(sortedAnchors).map(([k, sha]) => [k, { sha }])) });
  if (check.length > 0) throw new ActionError(`generated_at "${generatedAt}" is not usable: ${check[0].instancePath}: ${check[0].message}.`);

  const sections = processings.map((p) => {
    const list = resolved.get(p)!;
    const src = (m: Manifest, s: Src): string => {
      if (s.kind === 'spec') return `spec: ${s.ref}`;
      if (s.kind === 'code' && m.repo !== undefined) return `code: ${m.repo}@${m.sha7}:${s.ref}`;
      return `declared: ${m.file} (${s.ref})`;
    };

    const subjects: Cand[] = (p.data_subjects as string[]).map((value) => ({ value, source: processingSource(p.source) }));
    const personal: Cand[] = [];
    const recipientCands: Cand[] = [];
    const recipientNames: string[] = [];
    const transferCands: { name: string; country: string; source: string }[] = [];
    const storageRows: Cand[] = [];
    const processors: { name: string; country: string; safeguard?: string }[] = [];
    /** `<item>\0<value>` to the open item that row raises, set where the value is built. */
    const openOf = new Map<string, string>();

    for (const { m, scope, recipients } of list) {
      const d = m.doc;
      const inScope = (data: string[] | undefined): boolean => (data ?? []).some((id) => scope.has(id));
      for (const item of (d.personal_data as Doc[]).filter((x) => scope.has(x.id))) {
        const source = src(m, item.source);
        for (const s of item.subjects as string[]) subjects.push({ value: s, source });
        const byCategory = new Map<string, Set<string>>();
        for (const f of item.fields as Doc[]) byCategory.set(f.category, (byCategory.get(f.category) ?? new Set()).add(f.name));
        for (const [category, names] of byCategory) {
          const value = `${category}: ${[...names].sort(cmp).join(', ')}`;
          personal.push({ value, source });
          if (category === 'unknown') openOf.set(`(c) Personal data\u0000${value}`, '(c) Personal data: category unknown');
        }
      }
      for (const st of (d.storage as Doc[]).filter((x) => inScope(x.data))) {
        const value = `${st.id} (${st.kind}): ${duration(st.retention)}`;
        storageRows.push({ value, source: src(m, st.source) });
        if (st.retention.duration === 'unknown') openOf.set(`(f) Erasure time limits\u0000${value}`, `(f) Erasure time limits: unknown for ${st.id}`);
      }
      const wanted = (x: Doc): boolean => (recipients ? recipients.has(x.id) : x.data === undefined || inScope(x.data));
      for (const pr of (d.processors as Doc[]).filter(wanted)) {
        const source = src(m, pr.source);
        const value = `${pr.name} (${pr.country})`;
        recipientCands.push({ value, source });
        recipientNames.push(pr.name);
        processors.push({ name: pr.name, country: pr.country, safeguard: pr.safeguard });
        if (pr.transfer_outside_eu === true) transferCands.push({ name: pr.name, country: pr.country, source });
      }
      for (const fl of (d.outbound_flows as Doc[]).filter(wanted)) {
        if (inside.has(fl.to.name)) continue;
        const source = src(m, fl.source);
        recipientCands.push({ value: `${fl.to.name} (${country(fl.to.country)})`, source });
        recipientNames.push(fl.to.name);
        if (fl.to.country === 'unknown' || !EU_EEA.has(fl.to.country)) transferCands.push({ name: fl.to.name, country: fl.to.country, source });
      }
    }

    for (const r of (p.recipients as Doc[] | undefined) ?? []) {
      if (recipientNames.some((n) => r.name === n || r.name.startsWith(`${n} (`))) continue;
      recipientCands.push({ value: r.name, source: processingSource(r.source) });
    }

    // A transfer value is `<name> (<country>): <safeguard>`; an unknown destination is to assess.
    const transfers = atomic(
      transferCands.map((t) => {
        const who = `${t.name} (${country(t.country)})`;
        if (t.country === 'unknown') {
          const value = `${who}: destination to assess`;
          openOf.set(`(e) Transfers\u0000${value}`, `(e) Transfers: destination to assess for ${who}`);
          return { value, source: t.source };
        }
        const safeguards = processors.filter((x) => x.name === t.name && x.country === t.country && x.safeguard !== undefined).map((x) => x.safeguard!).sort(cmp);
        const value = `${who}: ${safeguards[0] ?? 'safeguard not declared'}`;
        if (safeguards.length === 0) openOf.set(`(e) Transfers\u0000${value}`, `(e) Transfers: safeguard not declared for ${who}`);
        return { value, source: t.source };
      }),
    );

    const rows: { item: string; value: string; source: string }[] = [];
    // Open items, in the order of the rows, each once (templates/register/README.md, Open items).
    const open: string[] = [];
    const flag = (item: string): void => {
      if (!open.includes(item)) open.push(item);
    };
    const add = (item: string, cands: Cand[], empty?: string): void => {
      const all = cands.length > 0 ? cands : [{ value: empty ?? TO_COMPLETE, source: NO_SOURCE }];
      all.forEach((c, i) => {
        rows.push({ item: i === 0 ? item : '', value: c.value, source: c.source });
        if (NOT_COUNTED.has(item)) return;
        if (c.value === TO_COMPLETE) flag(item);
        const detail = openOf.get(`${item}\u0000${c.value}`);
        if (detail !== undefined) flag(detail);
      });
    };

    const controller = `${filled(p.controller.name)}, ${filled(p.controller.contact)}`;
    if (isPlaceholder(p.controller.name) || isPlaceholder(p.controller.contact)) openOf.set(`(a) Controller\u0000${controller}`, '(a) Controller');
    add('(a) Controller', [{ value: controller, source: processingSource(p.source) }]);
    add('(a) Joint controller', []);
    add('(a) Representative', []);
    if (p.dpo && (isPlaceholder(p.dpo.name) || isPlaceholder(p.dpo.contact))) openOf.set(`(a) Data protection officer\u0000${filled(p.dpo.name)}, ${filled(p.dpo.contact)}`, '(a) Data protection officer');
    add('(a) Data protection officer', p.dpo ? [{ value: `${filled(p.dpo.name)}, ${filled(p.dpo.contact)}`, source: processingSource(p.source) }] : []);
    add('(b) Purposes', [{ value: p.purpose, source: processingSource(p.source) }]);
    add('(c) Data subjects', atomic(subjects));
    add('(c) Personal data', composite(personal));
    add('(d) Recipients', atomic(recipientCands), NONE_IDENTIFIED);
    add('(e) Transfers', transfers, NONE_IDENTIFIED);
    if (p.retention?.duration === 'unknown') openOf.set(`(f) Erasure time limits\u0000${duration(p.retention)}`, '(f) Erasure time limits: unknown');
    add('(f) Erasure time limits', p.retention ? [{ value: duration(p.retention), source: processingSource(p.retention.source) }] : composite(storageRows));
    add('(g) Security measures', atomic(((p.security_measures as Doc[] | undefined) ?? []).map((s) => ({ value: s.measure, source: processingSource(s.source) }))));

    return {
      id: cell(p.id),
      name: cell(p.name),
      rows: rows.map((r) => ({ item: cell(r.item), value: cell(r.value), source: cell(r.source) })),
      open: { id: p.id as string, name: p.name as string, items: open },
    };
  });

  let template = readFileSync(TEMPLATE_URL, 'utf8');
  // With no anchor, `anchors: {}` takes the place of the block.
  if (Object.keys(sortedAnchors).length === 0) template = template.replace(/^anchors:\n\{\{#each anchors\}\}\n[\s\S]*?\{\{\/each\}\}\n/m, 'anchors: {}\n');
  const open = sections.map((x) => x.open);
  const count = open.reduce((n, x) => n + x.items.length, 0);
  const markdown = renderTemplate(template, {
    spec_version: SPEC_VERSION,
    generated_at: generatedAt,
    open_items: String(count),
    open_summary: openSummary(count, open.filter((x) => x.items.length > 0).length, open.length),
    open: open.map((x) => ({ name: cell(`${x.name} (${x.id})`), items: cell(x.items.length > 0 ? x.items.join('; ') : 'None') })),
    organisation: cell(compliance.organisation.name),
    anchors: Object.entries(sortedAnchors).map(([repo, sha]) => ({ repo, sha: JSON.stringify(sha) })),
    processings: sections.map(({ id, name, rows }) => ({ id, name, rows })),
  });
  return { markdown, anchors: sortedAnchors, open };
}

/** The anchors.yaml that goes with a register: same repos, same shas, same generated_at. */
export function anchorsYaml(anchors: Record<string, string>, generatedAt: string): string {
  const doc = {
    spec_version: SPEC_VERSION,
    generated_at: generatedAt,
    repos: Object.fromEntries(Object.entries(anchors).map(([repo, sha]) => [repo, { sha }])),
  };
  return stringify(doc, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
}

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

/** True when regenerating with the previous generated_at gives the files already there, byte for byte. */
function isUpToDate(root: string, previous: string): boolean {
  const registerPath = join(root, 'documents', 'register.md');
  if (!existsSync(registerPath)) return false;
  // previous passed the anchors schema, so buildRegister only fails on what the regular build fails on.
  const same = buildRegister(root, previous);
  return (
    readFileSync(registerPath, 'utf8') === same.markdown &&
    readFileSync(join(root, 'anchors.yaml'), 'utf8') === anchorsYaml(same.anchors, previous)
  );
}

// ---------- the mode ----------

export interface RegisterOptions {
  compliancePath: string;
  baseBranch: string;
  token: string;
  /** RFC 3339. Default: the commit time of HEAD of the compliance repo, so that reruns give the same bytes. */
  generatedAt?: string;
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

  const remoteEnv = remoteAuthEnv(o.token);
  const { existing, remoteSha } = await guardBotBranch({ git, api: o.api, root, repo, branch, base, remoteEnv });
  await mustGit(git, ['checkout', '-B', branch, `origin/${base}`], root);

  assertNoSymlink(root, 'documents');
  assertNoSymlink(root, 'documents', 'register.md');
  assertNoSymlink(root, 'anchors.yaml');

  // A commit that changes nothing in the register (a receive with no processing using it)
  // must not open a pull request whose only change is generated_at.
  const previous = previousGeneratedAt(root);
  if (previous && isUpToDate(root, previous)) {
    core.notice(`The register and anchors.yaml are already up to date with origin/${base}: nothing to commit.`);
    return;
  }

  const generatedAt = o.generatedAt || (await mustGit(git, ['log', '-1', '--format=%cI'], root));
  const { markdown, anchors, open } = buildRegister(root, generatedAt);

  mkdirSync(join(root, 'documents'), { recursive: true });
  writeNoFollow(join(root, 'documents', 'register.md'), markdown);
  writeNoFollow(join(root, 'anchors.yaml'), anchorsYaml(anchors, generatedAt));

  await mustGit(git, ['add', '--', 'documents/register.md', 'anchors.yaml'], root);
  const staged = await git(['diff', '--cached', '--quiet'], root);
  if (staged.code === 0) {
    core.notice(`The register and anchors.yaml are already up to date with origin/${base}: nothing to commit.`);
    return;
  }

  const body = [
    'Records of processing activities (GDPR Art. 30(1)) generated from the compliance repo.',
    '',
    `- Generated at: \`${generatedAt}\``,
    `- Repos documented: ${Object.keys(anchors).length > 0 ? Object.entries(anchors).map(([r, sha]) => `\`${r}\` at \`${sha.slice(0, 7)}\``).join(', ') : 'none'}`,
    `- Open items: ${openSummary(open.reduce((n, x) => n + x.items.length, 0), open.filter((x) => x.items.length > 0).length, open.length)}`,
    ...open.filter((x) => x.items.length > 0).map((x) => `  - ${codeSpan(`${x.name} (${x.id})`)}: ${x.items.map(codeSpan).join(', ')}`),
    '',
    'This document is prepared for review by the controller and its data protection officer. It does not certify compliance with the GDPR. Open items are listed first in the register: rows marked `To complete` have no source and need a person, and joint controller and representative are always to confirm by hand.',
    '',
    'Merging this pull request records `anchors.yaml`: the lag of each service then restarts from 0. Written by compliance-action; do not edit `documents/register.md` or `anchors.yaml` by hand.',
  ].join('\n');
  await commitPushAndOpenPr({ git, api: o.api, root, repo, branch, base, remoteEnv, existing, remoteSha, title: REGISTER_TITLE, body });
}
