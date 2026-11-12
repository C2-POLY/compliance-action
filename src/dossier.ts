import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertNoSymlink } from './bot.js';
import { ActionError } from './errors.js';
import {
  EU_EEA,
  atomic,
  cell,
  cmp,
  composite,
  duration,
  existsNoFollow,
  isPlaceholder,
  listDirs,
  processingSource,
  readDoc,
  renderTemplate,
  type Cand,
  type Context,
  type Doc,
  type Manifest,
  type Src,
} from './register.js';
import { validateDocument, versionOf } from './schema.js';

// The v0.2 compliance dossier: the rules are in templates/register/README.md of the spec, part "v0.2: the compliance dossier".
// Only functions use the imports of register.js (which imports this module): nothing runs at load time.

const DOSSIER_VERSION = '0.2';
const TEMPLATES = {
  en: new URL('../templates/register/register.en.md.tmpl', import.meta.url),
  fr: new URL('../templates/register/register.fr.md.tmpl', import.meta.url),
};

export const LANGUAGES = ['en', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];

const NO_SOURCE = '—';
const FROM_COMPLIANCE = 'declared: compliance.yaml';

// ---------- translations ----------

const WORDS = {
  en: {
    toComplete: 'To complete',
    noneFound: 'None identified in the sources',
    none: 'None',
    notExpected: 'Not expected for this legal basis',
    notDesignated: 'Not designated',
    notRequired: 'Not required',
    countryUnknown: 'country unknown',
    destinationToAssess: 'destination to assess',
    safeguardNotDeclared: 'safeguard not declared',
    arrangement: 'arrangement',
    interest: 'Interest',
    necessity: 'Necessity',
    impact: 'Impact',
    safeguards: 'Safeguards',
    collection: 'Collection',
    withdrawal: 'Withdrawal',
    reference: 'Reference',
    required: 'Required',
    criteria: 'Criteria',
    dpa: 'DPA',
  },
  fr: {
    toComplete: 'À compléter',
    noneFound: 'Aucun identifié dans les sources',
    none: 'Aucun',
    notExpected: 'Non attendu pour cette base légale',
    notDesignated: 'Non désigné',
    notRequired: 'Non requis',
    countryUnknown: 'pays inconnu',
    destinationToAssess: 'destination à évaluer',
    safeguardNotDeclared: 'garantie non déclarée',
    arrangement: 'accord',
    interest: 'Intérêt',
    necessity: 'Nécessité',
    impact: 'Impact',
    safeguards: 'Garanties',
    collection: 'Recueil',
    withdrawal: 'Retrait',
    reference: 'Référence',
    required: 'Requise',
    criteria: 'Critères',
    dpa: 'DPA',
  },
};

const LABELS = {
  en: {
    organisation: ['Controller', 'Data protection officer', 'Representative (Art. 27)', 'Privacy contact'],
    art30: ['(a) Controller', '(a) Joint controller', '(a) Representative', '(a) Data protection officer', '(b) Purposes', '(c) Data subjects', '(c) Personal data', '(d) Recipients', '(e) Transfers', '(f) Erasure time limits', '(g) Security measures'],
    checks: ['Legal basis', 'Legal basis detail', 'DPIA', 'Information of persons', 'Sensitive data', 'Processor contracts'],
    places: { organisation: 'Organisation', ai: 'AI features', outside: 'Outside the register' },
  },
  fr: {
    organisation: ['Responsable du traitement', 'Délégué à la protection des données', 'Représentant (art. 27)', "Contact pour l'exercice des droits"],
    art30: ['(a) Responsable du traitement', '(a) Responsable conjoint', '(a) Représentant', '(a) Délégué à la protection des données', '(b) Finalités', '(c) Personnes concernées', '(c) Données personnelles', '(d) Destinataires', '(e) Transferts', "(f) Délais d'effacement", '(g) Mesures de sécurité'],
    checks: ['Base légale', 'Détail de la base légale', 'AIPD', 'Information des personnes', 'Données sensibles', 'Contrats de sous-traitance'],
    places: { organisation: 'Organisation', ai: "Fonctionnalités d'IA", outside: 'Hors du registre' },
  },
};

type Role = 'organisation' | 'dpo' | 'developer';
const ROLES: Record<Role, { order: number; en: string; fr: string }> = {
  organisation: { order: 0, en: 'Organisation', fr: 'Organisation' },
  dpo: { order: 1, en: 'DPO', fr: 'DPO' },
  developer: { order: 2, en: 'Developer', fr: 'Développeur' },
};

const ACTIONS = {
  'organisation-identity': { role: 'organisation', en: "Complete the controller's identity", fr: "Compléter l'identité du responsable du traitement" },
  'organisation-dpo': { role: 'organisation', en: 'Designate a DPO, or state why none is required', fr: "Désigner un DPO, ou indiquer pourquoi aucun n'est requis" },
  'organisation-representative': { role: 'organisation', en: 'State whether a representative in the EU is required (Art. 27)', fr: "Indiquer si un représentant dans l'UE est requis (art. 27)" },
  'joint-controllers': { role: 'organisation', en: 'List the joint controllers, or state that there are none', fr: "Lister les responsables conjoints, ou indiquer qu'il n'y en a pas" },
  'personal-data': { role: 'developer', en: 'Describe the personal data and classify the unknown categories', fr: 'Décrire les données personnelles et classer les catégories inconnues' },
  'transfer-safeguards': { role: 'developer', en: 'Declare the safeguard of each transfer outside the EU', fr: "Déclarer la garantie de chaque transfert hors de l'UE" },
  'processor-contracts': { role: 'organisation', en: 'Sign or locate the processor contracts (Art. 28)', fr: 'Signer ou retrouver les contrats de sous-traitance (art. 28)' },
  retention: { role: 'dpo', en: 'Set the retention periods', fr: 'Fixer les durées de conservation' },
  'security-measures': { role: 'developer', en: 'Describe the security measures', fr: 'Décrire les mesures de sécurité' },
  'legal-basis-detail': { role: 'dpo', en: 'Document the legal basis', fr: 'Documenter la base légale' },
  dpia: { role: 'dpo', en: 'Assess whether a DPIA is required, and reference it', fr: 'Évaluer si une AIPD est requise, et la référencer' },
  information: { role: 'organisation', en: 'State how the persons are informed (Art. 13 and 14)', fr: 'Indiquer comment les personnes sont informées (art. 13 et 14)' },
  'sensitive-data': { role: 'dpo', en: 'Assess the sensitive data (Art. 9)', fr: 'Évaluer les données sensibles (art. 9)' },
  'ai-classification': { role: 'dpo', en: 'Classify the AI features: role and risk level', fr: "Classer les fonctionnalités d'IA : rôle et niveau de risque" },
  'ai-obligations': { role: 'developer', en: 'Meet or document the AI Act obligations', fr: "Remplir ou documenter les obligations de l'AI Act" },
  'controller-rationale': { role: 'dpo', en: 'Explain why the organisation is not the controller', fr: "Expliquer pourquoi l'organisation n'est pas responsable du traitement" },
} satisfies Record<string, { role: Role; en: string; fr: string }>;
export type ActionId = keyof typeof ACTIONS;

export const actionLabel = (id: ActionId, language: Language): string => ACTIONS[id][language];
export const roleLabel = (role: Role, language: Language): string => ROLES[role][language];

/** `<N>(s)`: English singular for 1, French singular for 0 and 1. */
const plural = (n: number, language: Language, one: string, many: string): string => ((language === 'fr' ? n <= 1 : n === 1) ? one : many);

export function actionsSummary(openItems: number, actions: number, language: Language): string {
  if (openItems === 0) return language === 'fr' ? 'Aucun point ouvert.' : 'No open item.';
  if (language === 'fr') {
    return `${openItems} ${plural(openItems, language, 'point ouvert', 'points ouverts')}, ${plural(openItems, language, 'fermé', 'fermés')} par ${actions} ${plural(actions, language, 'action', 'actions')}.`;
  }
  return `${openItems} open ${plural(openItems, language, 'item', 'items')}, closed by ${actions} ${plural(actions, language, 'action', 'actions')}.`;
}

function aiSummary(k: number, language: Language): string {
  if (language === 'fr') return k === 0 ? "Aucune fonctionnalité d'IA dans les services des traitements." : `${k} ${plural(k, language, 'fonctionnalité', 'fonctionnalités')} d'IA dans les services des traitements.`;
  return k === 0 ? 'No AI feature in the services of the processing activities.' : `${k} AI ${plural(k, language, 'feature', 'features')} in the services of the processing activities.`;
}

function outsideSummary(k: number, language: Language): string {
  if (language === 'fr') {
    return k === 0
      ? "Tous les services et composants ont l'organisation pour responsable."
      : `${k} ${plural(k, language, 'service', 'services')} ou ${plural(k, language, 'composant', 'composants')} dont le responsable n'est pas l'organisation seule.`;
  }
  return k === 0
    ? 'Every service and component is controlled by the organisation.'
    : `${k} ${plural(k, language, 'service', 'services')} or ${plural(k, language, 'component', 'components')} whose controller is not the organisation alone.`;
}

// ---------- AI Act ----------

const HIGH_RISK = ['art9-risk-management', 'art10-data-governance', 'art11-technical-documentation', 'art12-logging', 'art13-transparency', 'art14-human-oversight', 'art15-accuracy-robustness'];

/** The obligations the dossier expects of a feature (spec/manifest.md, ai_features). */
function expectedObligations(f: Doc): string[] {
  const out = ['art4-ai-literacy'];
  if (f.interacts_with_persons === true) out.push('art50-interaction');
  if (f.generates_content === true) out.push('art50-synthetic-content');
  if (f.risk?.level === 'high') {
    out.push(...HIGH_RISK);
    if (f.role === 'deployer') out.push('art26-deployer-duties', 'art27-fria');
  }
  return out;
}

// ---------- the dossier ----------

/** A manifest with the name the dossier shows for it: the repo name or the declared tool id. */
type Labelled = Manifest & { label: string };

interface Row {
  item: string;
  value: string;
  source: string;
}

export interface DossierAction {
  id: ActionId;
  role: Role;
  count: number;
}

export interface Dossier {
  markdown: string;
  /** Repo name to the full sha of its sync.yaml, sorted by repo name. */
  anchors: Record<string, string>;
  openItems: number;
  /** In the order of the Actions table. */
  actions: DossierAction[];
}

/** Places of the open items that are not a processing (a processing is its id, which cannot start with `#`). */
const ORGANISATION = '#organisation';
const AI_FEATURES = '#ai';
const OUTSIDE = '#outside';

/** Builds the v0.2 dossier from a checkout of a v0.2 compliance repo. Pure: reads files, never the clock. */
export function buildDossier(complianceDir: string, generatedAt: string, language: Language): Dossier {
  const W = WORDS[language];
  const L = LABELS[language];
  const TC = W.toComplete;
  const fill = (value: string): string => (isPlaceholder(value) ? TC : value);

  const root = resolve(complianceDir);
  const compliance = readDoc(root, 'compliance.yaml', 'compliance');
  if (versionOf(compliance) !== DOSSIER_VERSION) throw new ActionError(`compliance.yaml is spec_version "${compliance.spec_version}": the dossier needs "${DOSSIER_VERSION}".`);
  const org = compliance.organisation as Doc;
  const repos = compliance.repos as Doc[];
  const tools = (compliance.declared_tools as Doc[] | undefined) ?? [];
  // Repos and tools share one namespace in the dossier (labels, open item subjects): a clash would merge two open items into one.
  for (const t of tools) {
    if (repos.some((r) => r.name === t.id)) throw new ActionError(`compliance.yaml: "${t.id}" is both a repo and a declared tool. Rename one. Nothing was generated.`);
  }

  // ---------- loading ----------

  const manifests = new Map<string, Labelled>();
  const loadRepo = (repo: string, who: string): Labelled => {
    if (!repos.some((r) => r.name === repo)) throw new ActionError(`${who}: repo "${repo}" is not listed in compliance.yaml.`);
    if (repo === '.' || repo === '..') throw new ActionError(`${who}: "${repo}" is not a repo name.`);
    const file = `services/${repo}/manifest.yaml`;
    const known = manifests.get(file);
    if (known) return known;
    const doc = readDoc(root, file, 'manifest');
    const sync = readDoc(root, `services/${repo}/sync.yaml`, 'sync');
    const m: Labelled = { file, doc, repo, sha: sync.sha as string, sha7: (sync.sha as string).slice(0, 7), label: repo };
    manifests.set(file, m);
    return m;
  };
  const loadTool = (tool: string, who: string): Labelled => {
    const entry = tools.find((t) => t.id === tool);
    if (!entry) throw new ActionError(`${who}: tool "${tool}" is not listed in declared_tools of compliance.yaml.`);
    const known = manifests.get(entry.path);
    if (known) return known;
    const m: Labelled = { file: entry.path, doc: readDoc(root, entry.path, 'manifest'), label: tool };
    manifests.set(entry.path, m);
    return m;
  };
  const loadEntry = (e: { repo?: string; tool?: string }, who: string): Labelled => (e.repo !== undefined ? loadRepo(e.repo, who) : loadTool(e.tool!, who));

  // Every manifest of the compliance repo: the repos that have a services/<repo>/ folder, then the declared tools.
  const all: Labelled[] = [];
  for (const r of repos) {
    if (r.name === '.' || r.name === '..') throw new ActionError(`compliance.yaml: "${r.name}" is not a repo name.`);
    assertNoSymlink(root, 'services', r.name);
    if (existsSync(join(root, 'services', r.name))) all.push(loadRepo(r.name, 'compliance.yaml'));
  }
  for (const t of tools) all.push(loadTool(t.id, 'compliance.yaml'));
  const inside = new Set(all.map((m) => m.doc.service.name as string));

  const anchors = Object.fromEntries(all.filter((m) => m.repo !== undefined).map((m) => [m.repo!, m.sha!] as const).sort(([a], [b]) => cmp(a, b)));
  const anchorErrors = validateDocument('anchors', { spec_version: DOSSIER_VERSION, generated_at: generatedAt, repos: Object.fromEntries(Object.entries(anchors).map(([k, sha]) => [k, { sha }])) });
  if (anchorErrors.length > 0) throw new ActionError(`generated_at "${generatedAt}" is not usable: ${anchorErrors[0].instancePath}: ${anchorErrors[0].message}.`);

  const processings: Doc[] = listDirs(root, 'processings')
    .filter((d) => existsNoFollow(join(root, 'processings', d, 'processing.yaml')))
    .map((d) => readDoc(root, `processings/${d}/processing.yaml`, 'processing'))
    .sort((a, b) => cmp(a.id, b.id));
  for (let i = 1; i < processings.length; i++) {
    if (processings[i].id === processings[i - 1].id) throw new ActionError(`Two processings have the id "${processings[i].id}".`);
  }

  // Resolve every reference first: an unresolved one fails before anything is built.
  type Entry = { m: Labelled; scope: Set<string>; recipients?: Set<string> };
  type Notice = { m: Labelled; notice: Doc };
  const entries = new Map<Doc, Entry[]>();
  const notices = new Map<Doc, Notice[]>();
  const referenced = new Set<Labelled>();
  for (const p of processings) {
    const who = `processings/${p.id}`;
    entries.set(
      p,
      (p.services as Doc[]).map((entry) => {
        const m = loadEntry(entry, who);
        referenced.add(m);
        const ids = new Set<string>((m.doc.personal_data as Doc[]).map((d) => d.id));
        for (const id of (entry.data as string[] | undefined) ?? []) {
          if (!ids.has(id)) throw new ActionError(`${who}: no personal_data "${id}" in ${m.file}.`);
        }
        const recipientIds = new Set<string>([...m.doc.processors, ...m.doc.outbound_flows].map((x: Doc) => x.id));
        for (const id of (entry.recipients as string[] | undefined) ?? []) {
          if (!recipientIds.has(id)) throw new ActionError(`${who}: no processor or outbound flow "${id}" in ${m.file}.`);
        }
        return { m, scope: entry.data ? new Set<string>(entry.data) : ids, recipients: entry.recipients ? new Set<string>(entry.recipients) : undefined };
      }),
    );
    notices.set(
      p,
      ((p.information?.notices as Doc[] | undefined) ?? []).map((ref) => {
        const m = loadEntry(ref, `${who} (information)`);
        const notice = ((m.doc.notices as Doc[] | undefined) ?? []).find((n) => n.id === ref.id);
        if (!notice) throw new ActionError(`${who} (information): no notice "${ref.id}" in ${m.file}.`);
        return { m, notice };
      }),
    );
  }

  // ---------- open items ----------

  /** Place, kind and subject: an open item found twice in one place is one open item. */
  const opens = new Map<string, { place: string; kind: ActionId }>();
  const flag = (place: string, kind: ActionId, subject: string): void => {
    opens.set(`${place}\u0000${kind}\u0000${subject}`, { place, kind });
  };

  const src = (m: Manifest, s: Src): string => {
    if (s.kind === 'spec') return `spec: ${s.ref}`;
    if (s.kind === 'code' && m.repo !== undefined) return `code: ${m.repo}@${m.sha7}:${s.ref}`;
    return `declared: ${m.file} (${s.ref})`;
  };
  /** One row per value; the label on the first one. A value with no source is a placeholder: its source is `—`. */
  const rowsOf = (item: string, cands: Cand[]): Row[] => cands.map((c, i) => ({ item: i === 0 ? item : '', value: c.value, source: c.source }));
  const placeholder = (value: string): Cand => ({ value, source: NO_SOURCE });

  // ---------- Organisation ----------

  const orgRow = (value: string | undefined): Cand => (value === undefined ? placeholder(TC) : { value, source: FROM_COMPLIANCE });
  const oc = org.controller as Doc | undefined;
  const orgController = oc ? [oc.legal_name, oc.address, oc.registration, oc.contact].filter((x) => x !== undefined).map(fill).join(', ') : undefined;
  const orgControllerOpen = !oc || [oc.legal_name, oc.address, oc.registration, oc.contact].some((x) => x !== undefined && isPlaceholder(x));

  const od = org.dpo as Doc | undefined;
  let orgDpo: string | undefined;
  let orgDpoOpen = false;
  if (!od || od.designated === 'unknown') orgDpoOpen = true;
  else if (od.designated === true) {
    orgDpo = `${fill(od.name)}, ${fill(od.contact)}`;
    orgDpoOpen = isPlaceholder(od.name) || isPlaceholder(od.contact);
  } else orgDpo = `${W.notDesignated}: ${od.reason}`;

  const or = org.representative as Doc | undefined;
  let orgRepresentative: string | undefined;
  if (!or || or.required === 'unknown') flag(ORGANISATION, 'organisation-representative', 'representative');
  else if (or.required === true) {
    orgRepresentative = `${fill(or.name)}, ${fill(or.contact)}`;
    if (isPlaceholder(or.name) || isPlaceholder(or.contact)) flag(ORGANISATION, 'organisation-representative', 'representative');
  } else orgRepresentative = or.reason !== undefined ? `${W.notRequired}: ${or.reason}` : W.notRequired;

  // A privacy contact written `to complete` is the placeholder itself: it has no source.
  const privacy = org.privacy_contact as string | undefined;
  const organisationRows: Row[] = [
    ...rowsOf(L.organisation[0], [orgRow(orgController)]),
    ...rowsOf(L.organisation[1], [orgRow(orgDpo)]),
    ...rowsOf(L.organisation[2], [orgRow(orgRepresentative)]),
    ...rowsOf(L.organisation[3], [privacy === undefined || isPlaceholder(privacy) ? placeholder(TC) : orgRow(privacy)]),
  ];

  // ---------- processings ----------

  const sections = processings.map((p) => {
    const place = p.id as string;
    const P = `declared: ${p.source.ref}`;
    const list = entries.get(p)!;

    // (a)
    let controller: Cand;
    if (p.controller) {
      controller = { value: `${fill(p.controller.name)}, ${fill(p.controller.contact)}`, source: P };
      if (isPlaceholder(p.controller.name) || isPlaceholder(p.controller.contact)) flag(place, 'organisation-identity', 'controller');
    } else {
      controller = orgRow(orgController);
      if (orgControllerOpen) flag(place, 'organisation-identity', 'controller');
    }

    let joint: Cand[];
    const jc = p.joint_controllers as Doc[] | undefined;
    if (jc === undefined) {
      joint = [placeholder(TC)];
      flag(place, 'joint-controllers', 'joint controllers');
    } else if (jc.length === 0) joint = [{ value: W.none, source: P }];
    else {
      joint = jc.map((j) => ({ value: `${fill(j.name)}, ${fill(j.contact)} (${W.arrangement}: ${fill(j.arrangement)})`, source: P })).sort((a, b) => cmp(a.value, b.value));
      if (jc.some((j) => [j.name, j.contact, j.arrangement].some(isPlaceholder))) flag(place, 'joint-controllers', 'joint controllers');
    }

    let dpo: Cand;
    if (p.dpo) {
      dpo = { value: `${fill(p.dpo.name)}, ${fill(p.dpo.contact)}`, source: P };
      if (isPlaceholder(p.dpo.name) || isPlaceholder(p.dpo.contact)) flag(place, 'organisation-dpo', 'dpo');
    } else {
      dpo = orgRow(orgDpo);
      if (orgDpoOpen) flag(place, 'organisation-dpo', 'dpo');
    }

    // (c), (f), and the processors and flows of (d) and (e)
    const subjects: Cand[] = (p.data_subjects as string[]).map((value) => ({ value, source: processingSource(p.source) }));
    const personal: Cand[] = [];
    const storageRows: Cand[] = [];
    const procs: { m: Labelled; pr: Doc }[] = [];
    const flows: { m: Labelled; fl: Doc; linked?: Doc }[] = [];
    const seenProcs = new Set<string>();
    for (const { m, scope, recipients } of list) {
      const d = m.doc;
      const inScope = (data: string[] | undefined): boolean => (data ?? []).some((id) => scope.has(id));
      for (const item of (d.personal_data as Doc[]).filter((x) => scope.has(x.id))) {
        const source = src(m, item.source);
        for (const s of item.subjects as string[]) subjects.push({ value: s, source });
        const byCategory = new Map<string, Set<string>>();
        for (const f of item.fields as Doc[]) byCategory.set(f.category, (byCategory.get(f.category) ?? new Set()).add(f.name));
        for (const [category, names] of byCategory) {
          personal.push({ value: `${category}: ${[...names].sort(cmp).join(', ')}`, source });
          if (category === 'unknown') flag(place, 'personal-data', 'unknown');
        }
      }
      for (const st of (d.storage as Doc[]).filter((x) => inScope(x.data))) {
        storageRows.push({ value: `${st.id} (${st.kind}): ${duration(st.retention)}`, source: src(m, st.source) });
        if (!p.retention && st.retention.duration === 'unknown') flag(place, 'retention', `storage ${st.id}`);
      }
      const wanted = (x: Doc): boolean => (recipients ? recipients.has(x.id) : x.data === undefined || inScope(x.data));
      const addProc = (pr: Doc): void => {
        const key = `${m.file}\u0000${pr.id}`;
        if (seenProcs.has(key)) return;
        seenProcs.add(key);
        procs.push({ m, pr });
      };
      for (const pr of (d.processors as Doc[]).filter(wanted)) addProc(pr);
      for (const fl of (d.outbound_flows as Doc[]).filter(wanted)) {
        // Linked by its `processor`, or, without one, by the same name and country (the v0.1 matching).
        const linked = (d.processors as Doc[]).find((x) => (fl.processor !== undefined ? x.id === fl.processor : x.name === fl.to.name && x.country === fl.to.country));
        if (linked) addProc(linked);
        flows.push({ m, fl, linked });
      }
    }

    // (d) Recipients
    const processorValue = (pr: Doc): string => `${pr.name} (${pr.country}): ${W.dpa} ${pr.dpa}`;
    const recipientCands: Cand[] = [];
    const recipientNames: string[] = [];
    for (const { m, pr } of procs) {
      recipientCands.push({ value: processorValue(pr), source: src(m, pr.source) });
      recipientNames.push(pr.name);
    }
    for (const { m, fl, linked } of flows) {
      if (linked || inside.has(fl.to.name)) continue;
      recipientCands.push({ value: `${fl.to.name} (${fl.to.country === 'unknown' ? W.countryUnknown : fl.to.country})`, source: src(m, fl.source) });
      recipientNames.push(fl.to.name);
    }
    for (const r of (p.recipients as Doc[] | undefined) ?? []) {
      if (recipientNames.some((n) => r.name === n || r.name.startsWith(`${n} (`))) continue;
      recipientCands.push({ value: r.name, source: processingSource(r.source) });
    }

    // (e) Transfers
    const transferCands: Cand[] = [];
    const transfer = (name: string, country: string, safeguard: string | undefined, source: string): void => {
      const unknown = country === 'unknown';
      const fallback = unknown ? W.destinationToAssess : W.safeguardNotDeclared;
      transferCands.push({ value: `${name} (${unknown ? W.countryUnknown : country}): ${safeguard ?? fallback}`, source });
      if (safeguard === undefined) flag(place, 'transfer-safeguards', `${name} (${country})`);
    };
    for (const { m, pr } of procs) if (pr.transfer_outside_eu === true) transfer(pr.name, pr.country, pr.safeguard, src(m, pr.source));
    for (const { m, fl, linked: x } of flows) {
      if (x) {
        if (x.transfer_outside_eu === true || !EU_EEA.has(x.country)) {
          transfer(x.name, x.country, fl.safeguard ?? x.safeguard, fl.safeguard !== undefined ? src(m, fl.source) : src(m, x.source));
        }
      } else if (fl.to.country === 'unknown' || !EU_EEA.has(fl.to.country)) {
        transfer(fl.to.name, fl.to.country, fl.safeguard, src(m, fl.source));
      }
    }

    // (f) Erasure time limits
    let erasure: Cand[];
    if (p.retention) {
      erasure = [{ value: duration(p.retention), source: processingSource(p.retention.source) }];
      if (p.retention.duration === 'unknown') flag(place, 'retention', 'processing');
    } else if (storageRows.length > 0) erasure = composite(storageRows);
    else {
      erasure = [placeholder(TC)];
      flag(place, 'retention', 'processing');
    }

    // (g) Security measures
    const security = atomic(((p.security_measures as Doc[] | undefined) ?? []).map((s) => ({ value: s.measure, source: processingSource(s.source) })));
    if (security.length === 0) flag(place, 'security-measures', 'processing');

    const personalRows = composite(personal);
    if (personalRows.length === 0) flag(place, 'personal-data', 'To complete');
    const recipientRows = atomic(recipientCands);
    const transferRows = atomic(transferCands);

    const art30 = [
      [controller],
      joint,
      [orgRow(orgRepresentative)],
      [dpo],
      [{ value: p.purpose, source: processingSource(p.source) }],
      atomic(subjects),
      personalRows.length > 0 ? personalRows : [placeholder(TC)],
      recipientRows.length > 0 ? recipientRows : [placeholder(W.noneFound)],
      transferRows.length > 0 ? transferRows : [placeholder(W.noneFound)],
      erasure,
      security.length > 0 ? security : [placeholder(TC)],
    ];

    // DPO checks
    const basis = p.legal_basis as string;
    const detail = p.legal_basis_detail as Doc | undefined;
    let basisDetail: Cand[];
    let texts: string[] | undefined;
    if (basis === 'not-applicable') basisDetail = [placeholder(W.notExpected)];
    else {
      const parts: [string, string][] | undefined =
        basis === 'legitimate-interests'
          ? detail?.balancing_test && [
              [W.interest, detail.balancing_test.interest],
              [W.necessity, detail.balancing_test.necessity],
              [W.impact, detail.balancing_test.impact],
              [W.safeguards, detail.balancing_test.safeguards],
            ]
          : basis === 'consent'
            ? detail?.consent && [
                [W.collection, detail.consent.collection],
                [W.withdrawal, detail.consent.withdrawal],
              ]
            : detail?.reference !== undefined
              ? [[W.reference, detail.reference]]
              : undefined;
      if (parts) {
        texts = parts.map(([, text]) => text);
        basisDetail = parts.map(([label, text]) => ({ value: `${label}: ${fill(text)}`, source: P }));
      } else basisDetail = [placeholder(TC)];
      if (!texts || texts.some(isPlaceholder)) flag(place, 'legal-basis-detail', 'processing');
    }

    const dpia = p.dpia as Doc | undefined;
    let dpiaRow: Cand;
    if (!dpia) {
      dpiaRow = placeholder(TC);
      flag(place, 'dpia', 'processing');
    } else {
      let value = `${W.required}: ${dpia.required}`;
      if (dpia.criteria !== undefined) value += `; ${W.criteria}: ${dpia.criteria.length > 0 ? [...dpia.criteria].sort(cmp).join(', ') : W.none}`;
      if (dpia.ref !== undefined) value += `; ${W.reference}: ${fill(dpia.ref)}`;
      else if (dpia.required === 'yes') value += `; ${W.reference}: ${TC}`;
      dpiaRow = { value, source: P };
      if (dpia.required === 'to-assess' || (dpia.required === 'yes' && (dpia.ref === undefined || isPlaceholder(dpia.ref)))) flag(place, 'dpia', 'processing');
    }

    let information: Cand[];
    if (!p.information) {
      information = [placeholder(TC)];
      flag(place, 'information', 'processing');
    } else {
      information = atomic(
        notices.get(p)!.map(({ m, notice }) => {
          if (notice.kind === 'none') flag(place, 'information', `${m.label}/${notice.id}`);
          return { value: `${notice.kind}: ${notice.ref} (${m.label})`, source: src(m, notice.source) };
        }),
      );
      if (p.information.text !== undefined) information.push({ value: p.information.text, source: P });
    }

    const sensitive = p.sensitive_data as string | string[] | undefined;
    let sensitiveRow: Cand;
    if (sensitive === undefined) sensitiveRow = placeholder(TC);
    else sensitiveRow = { value: typeof sensitive === 'string' ? sensitive : [...sensitive].sort(cmp).join(', '), source: P };
    if (sensitive === undefined || sensitive === 'to-assess') flag(place, 'sensitive-data', 'processing');

    const contracts = atomic(
      procs.map(({ m, pr }) => {
        if (pr.dpa === 'no' || pr.dpa === 'unknown') flag(place, 'processor-contracts', `${pr.name} (${pr.country})`);
        return { value: `${processorValue(pr)}${pr.dpa_ref !== undefined ? ` (${pr.dpa_ref})` : ''}`, source: src(m, pr.source) };
      }),
    );

    const checks = [
      [{ value: basis, source: P }],
      basisDetail,
      [dpiaRow],
      information,
      [sensitiveRow],
      contracts.length > 0 ? contracts : [placeholder(W.noneFound)],
    ];

    return {
      id: p.id as string,
      name: p.name as string,
      rows: art30.flatMap((cands, i) => rowsOf(L.art30[i], cands)),
      checks: checks.flatMap((cands, i) => rowsOf(L.checks[i], cands)),
    };
  });

  // ---------- AI features ----------

  const aiRows = [...referenced]
    .flatMap((m) =>
      ((m.doc.ai_features as Doc[] | undefined) ?? []).map((f) => {
        const subject = `${m.label}/${f.id}`;
        if (f.role === undefined || f.role === 'to-assess') flag(AI_FEATURES, 'ai-classification', `${subject} role`);
        if (f.risk === undefined || f.risk.level === 'to-assess' || f.risk.level === 'prohibited') flag(AI_FEATURES, 'ai-classification', `${subject} risk`);
        const listed = (f.obligations as Doc[] | undefined) ?? [];
        const obligations: { id: string; text: string }[] = listed.map((o) => {
          if (o.status === 'open') flag(AI_FEATURES, 'ai-obligations', `${subject} ${o.id}`);
          return { id: o.id as string, text: `${o.id}: ${o.status}${o.ref !== undefined ? ` (${o.ref})` : ''}` };
        });
        for (const id of expectedObligations(f)) {
          if (listed.some((o) => o.id === id)) continue;
          flag(AI_FEATURES, 'ai-obligations', `${subject} ${id}`);
          obligations.push({ id, text: `${id}: ${TC}` });
        }
        return {
          service: m.label,
          id: f.id as string,
          feature: `${f.id}: ${f.description}`,
          role: (f.role as string | undefined) ?? TC,
          risk: f.risk ? (f.risk.reason !== undefined ? `${f.risk.level}: ${f.risk.reason}` : f.risk.level) : TC,
          obligations: obligations.sort((a, b) => cmp(a.id, b.id)).map((o) => o.text).join('; '),
          source: src(m, f.source),
        };
      }),
    )
    .sort((a, b) => cmp(a.service, b.service) || cmp(a.id, b.id));

  // ---------- Outside the register ----------

  const outsideRows: { service: string; controller: string; rationale: string; privacy_by_design: string; personal_data: string; source: string }[] = [];
  for (const m of all) {
    const s = m.doc.service as Doc;
    const components = (s.components as Doc[] | undefined) ?? [];
    const items = m.doc.personal_data as Doc[];
    const row = (service: string, controller: string, data: Doc[]): void => {
      if (s.controller_rationale === undefined) flag(OUTSIDE, 'controller-rationale', m.label);
      const pd = [...data]
        .sort((a, b) => cmp(a.id, b.id))
        .map((d) => `${d.id} (${[...new Set((d.fields as Doc[]).map((f) => f.category as string))].sort(cmp).join(', ')})`);
      outsideRows.push({
        service,
        controller,
        rationale: s.controller_rationale ?? TC,
        privacy_by_design: s.privacy_by_design ? [...s.privacy_by_design].sort(cmp).join('; ') : W.noneFound,
        personal_data: pd.length > 0 ? pd.join('; ') : W.noneFound,
        source: src(m, s.source),
      });
    };
    if (s.controller !== 'organisation') {
      const own = new Set(components.filter((c) => c.controller === undefined || c.controller === s.controller).map((c) => c.id));
      row(m.label, s.controller, items.filter((d) => d.component === undefined || own.has(d.component)));
    }
    for (const c of components) {
      if (c.controller === undefined || c.controller === 'organisation' || c.controller === s.controller) continue;
      row(`${m.label}/${c.id}`, c.controller, items.filter((d) => d.component === c.id));
    }
  }
  outsideRows.sort((a, b) => cmp(a.service, b.service));

  // ---------- actions ----------

  const order = [ORGANISATION, ...processings.map((p) => p.id as string), AI_FEATURES, OUTSIDE];
  const placeLabel = (place: string): string => (place === ORGANISATION ? L.places.organisation : place === AI_FEATURES ? L.places.ai : place === OUTSIDE ? L.places.outside : place);
  const byKind = new Map<ActionId, { count: number; places: Set<string> }>();
  for (const { place, kind } of opens.values()) {
    const a = byKind.get(kind) ?? { count: 0, places: new Set<string>() };
    a.count += 1;
    a.places.add(place);
    byKind.set(kind, a);
  }
  const actions = [...byKind]
    .map(([id, a]) => ({ id, role: ACTIONS[id].role as Role, count: a.count, places: order.filter((pl) => a.places.has(pl)) }))
    .sort((a, b) => ROLES[a.role].order - ROLES[b.role].order || b.count - a.count || cmp(a.id, b.id));
  const openItems = opens.size;

  // ---------- render ----------

  const escape = (rows: Row[]): Context[] => rows.map((r) => ({ item: cell(r.item), value: cell(r.value), source: cell(r.source) }));
  let template = readFileSync(TEMPLATES[language], 'utf8');
  // With no anchor, `anchors: {}` takes the place of the block.
  if (Object.keys(anchors).length === 0) template = template.replace(/^anchors:\n\{\{#each anchors\}\}\n[\s\S]*?\{\{\/each\}\}\n/m, 'anchors: {}\n');
  const markdown = renderTemplate(template, {
    spec_version: DOSSIER_VERSION,
    language,
    generated_at: generatedAt,
    open_items: String(openItems),
    action_count: String(actions.length),
    anchors: Object.entries(anchors).map(([repo, sha]) => ({ repo, sha })),
    organisation: cell(org.name),
    organisation_rows: escape(organisationRows),
    actions_summary: actionsSummary(openItems, actions.length, language),
    actions: actions.map((a) => ({ id: a.id, label: cell(ACTIONS[a.id][language]), role: cell(ROLES[a.role][language]), count: String(a.count), where: cell(a.places.map(placeLabel).join(', ')) })),
    processings: sections.map((x) => ({ id: cell(x.id), name: cell(x.name), rows: escape(x.rows), checks: escape(x.checks) })),
    ai_summary: aiSummary(aiRows.length, language),
    ai_features: aiRows.map((r) => ({ service: cell(r.service), feature: cell(r.feature), role: cell(r.role), risk: cell(r.risk), obligations: cell(r.obligations), source: cell(r.source) })),
    outside_summary: outsideSummary(outsideRows.length, language),
    outside: outsideRows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]))),
  });
  return { markdown, anchors, openItems, actions: actions.map(({ id, role, count }) => ({ id, role, count })) };
}
