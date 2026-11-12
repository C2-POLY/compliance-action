import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { actionsSummary, buildDossier, type Language } from '../src/dossier.js';
import { anchorsYaml, buildRegister, runRegister, type RegisterOptions } from '../src/register.js';
import { validateDocument } from '../src/schema.js';
import type { EventContext } from '../src/types.js';
import { EXAMPLE, EXAMPLE_V02, complianceRepo, git, mockApi, tmp } from './helpers.js';

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const GENERATED_AT = '2026-11-11T00:00:00Z';
const TOKEN = 'ghs_TESTTOKEN0123456789';
const golden = {
  en: readFileSync(join(EXAMPLE_V02, 'documents/register.md'), 'utf8'),
  fr: readFileSync(join(EXAMPLE_V02, 'documents/register.fr.md'), 'utf8'),
};
const goldenV01 = readFileSync(join(EXAMPLE, 'documents/register.md'), 'utf8');

/** The open items of the Bistro Booking example, per action. */
const EXAMPLE_ACTIONS = {
  information: 1,
  'joint-controllers': 1,
  'organisation-representative': 1,
  'processor-contracts': 1,
  'ai-classification': 1,
  'controller-rationale': 1,
  dpia: 1,
  'legal-basis-detail': 1,
  retention: 1,
  'sensitive-data': 1,
  'ai-obligations': 2,
  'personal-data': 1,
  'security-measures': 1,
  'transfer-safeguards': 1,
};

function copy(withGenerated = true): string {
  const dir = tmp('ca-dossier-');
  cpSync(EXAMPLE_V02, dir, { recursive: true });
  if (!withGenerated) {
    rmSync(join(dir, 'documents'), { recursive: true });
    rmSync(join(dir, 'anchors.yaml'));
  }
  return dir;
}

function edit(dir: string, rel: string, from: string, to: string): void {
  const file = join(dir, rel);
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
}

const counts = (dir: string): Record<string, number> => Object.fromEntries(buildDossier(dir, GENERATED_AT, 'en').actions.map((a) => [a.id, a.count]));
const md = (dir: string, language: Language = 'en'): string => buildDossier(dir, GENERATED_AT, language).markdown;
const section = (markdown: string, id: string): string => markdown.split(new RegExp(`^## .* \\(${id}\\)$`, 'm'))[1].split(/^## /m)[0];

const TB = 'processings/table-bookings/processing.yaml';
const ME = 'processings/marketing-emails/processing.yaml';
const API = 'services/bistro-api/manifest.yaml';
const WEB = 'services/bistro-web/manifest.yaml';

describe('buildDossier', () => {
  it('equals the golden dossiers of the v0.2 Bistro Booking example, byte for byte, in English and French', () => {
    expect(md(EXAMPLE_V02, 'en')).toBe(golden.en);
    expect(md(EXAMPLE_V02, 'fr')).toBe(golden.fr);
  });

  it('is deterministic, ignores the clock, and the two languages have the same lines and sources', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const a = buildDossier(EXAMPLE_V02, GENERATED_AT, 'en');
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      expect(buildDossier(EXAMPLE_V02, GENERATED_AT, 'en')).toEqual(a);
    } finally {
      vi.useRealTimers();
    }
    const sources = (text: string) => text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---')).map((l) => l.split(/(?<!\\)\|/).slice(1, -1).at(-1)!.trim());
    expect(golden.fr.split('\n')).toHaveLength(golden.en.split('\n').length);
    expect(sources(golden.fr).filter((s) => /^(code|spec|declared): |^—$/.test(s))).toEqual(sources(golden.en).filter((s) => /^(code|spec|declared): |^—$/.test(s)));
  });

  it('counts the open items per action, sorted by role, count and id, in the front matter too', () => {
    const d = buildDossier(EXAMPLE_V02, GENERATED_AT, 'en');
    expect(Object.fromEntries(d.actions.map((a) => [a.id, a.count]))).toEqual(EXAMPLE_ACTIONS);
    expect(d.actions.map((a) => a.id)).toEqual(Object.keys(EXAMPLE_ACTIONS));
    expect(d.openItems).toBe(15);
    const front = parse(d.markdown.split('---\n')[1]);
    expect(front).toEqual({ spec_version: '0.2', language: 'en', generated_at: GENERATED_AT, open_items: 15, actions: 14, anchors: d.anchors });
    expect(actionsSummary(1, 1, 'en')).toBe('1 open item, closed by 1 action.');
    expect(actionsSummary(1, 1, 'fr')).toBe('1 point ouvert, fermé par 1 action.');
    expect(actionsSummary(0, 0, 'fr')).toBe('Aucun point ouvert.');
  });

  it('anchors every repo with a services/ folder, as anchors.yaml with spec_version 0.2', () => {
    const { anchors } = buildDossier(EXAMPLE_V02, GENERATED_AT, 'en');
    expect(Object.keys(anchors)).toEqual(['bistro-api', 'bistro-web']);
    const text = anchorsYaml(anchors, GENERATED_AT, '0.2');
    expect(text).toBe(readFileSync(join(EXAMPLE_V02, 'anchors.yaml'), 'utf8'));
    expect(validateDocument('anchors', parse(text))).toEqual([]);

    // A repo no processing uses is still read and anchored.
    const dir = copy();
    cpSync(join(dir, 'services/bistro-web'), join(dir, 'services/bistro-analytics'), { recursive: true });
    edit(dir, 'services/bistro-analytics/manifest.yaml', 'name: Bistro Booking Web', 'name: Bistro Analytics');
    expect(Object.keys(buildDossier(dir, GENERATED_AT, 'en').anchors)).toEqual(['bistro-analytics', 'bistro-api', 'bistro-web']);
  });

  describe('open items, one test per kind, each with its action', () => {
    it('organisation-identity and organisation-dpo: counted in each processing that inherits them', () => {
      const dir = copy();
      edit(dir, 'compliance.yaml', '  controller:\n    legal_name: Bistro Booking Group SAS\n    address: 12 rue des Tables, 75011 Paris, France\n    registration: "RCS Paris 900 000 000"\n    contact: privacy@bistro-booking.example\n', '');
      edit(dir, 'compliance.yaml', '    designated: true\n    name: Data protection office\n    contact: dpo@bistro-booking.example\n', '    designated: unknown\n');
      const c = counts(dir);
      expect(c['organisation-identity']).toBe(1); // marketing-emails states its own controller
      expect(c['organisation-dpo']).toBe(2);
      const m = md(dir);
      expect(m).toContain('| Controller | To complete | — |');
      expect(section(m, 'table-bookings')).toContain('| (a) Controller | To complete | — |');
      expect(section(m, 'marketing-emails')).toContain('| (a) Controller | Bistro Booking Group, newsletter@bistro-booking.example | declared: marketing team |');
      expect(m).toContain('| `organisation-dpo`: Designate a DPO, or state why none is required | Organisation | 2 | marketing-emails, table-bookings |');
    });

    it('organisation-identity and organisation-dpo: a value written "to complete"', () => {
      const dir = copy();
      edit(dir, 'compliance.yaml', 'registration: "RCS Paris 900 000 000"', 'registration: "To Complete "');
      edit(dir, TB, 'joint_controllers: []', 'dpo: {name: to complete, contact: dpo@bistro-booking.example}\njoint_controllers: []');
      const c = counts(dir);
      expect(c['organisation-identity']).toBe(1);
      expect(c['organisation-dpo']).toBe(1);
      const m = section(md(dir), 'table-bookings');
      expect(m).toContain('| (a) Controller | Bistro Booking Group SAS, 12 rue des Tables, 75011 Paris, France, To complete, privacy@bistro-booking.example | declared: compliance.yaml |');
      expect(m).toContain('| (a) Data protection officer | To complete, dpo@bistro-booking.example | declared: operations team |');
    });

    it('a DPO not designated and a representative not required are values, not open items', () => {
      const dir = copy();
      edit(dir, 'compliance.yaml', '    designated: true\n    name: Data protection office\n    contact: dpo@bistro-booking.example\n', '    designated: false\n    reason: no large-scale monitoring\n');
      edit(dir, 'compliance.yaml', 'required: unknown', 'required: false\n    reason: established in the EU');
      const c = counts(dir);
      expect(c['organisation-dpo']).toBeUndefined();
      expect(c['organisation-representative']).toBeUndefined();
      const m = md(dir);
      expect(m).toContain('| Data protection officer | Not designated: no large-scale monitoring | declared: compliance.yaml |');
      expect(section(m, 'table-bookings')).toContain('| (a) Representative | Not required: established in the EU | declared: compliance.yaml |');
      expect(section(md(dir, 'fr'), 'table-bookings')).toContain('| (a) Délégué à la protection des données | Non désigné: no large-scale monitoring | declared: compliance.yaml |');
    });

    it('organisation-representative: required with a contact "to complete", counted once in Organisation', () => {
      const dir = copy();
      edit(dir, 'compliance.yaml', 'required: unknown', 'required: true\n    name: EU Rep\n    contact: to complete');
      const d = buildDossier(dir, GENERATED_AT, 'en');
      expect(d.actions.find((a) => a.id === 'organisation-representative')?.count).toBe(1);
      expect(d.markdown).toContain('| Representative (Art. 27) | EU Rep, To complete | declared: compliance.yaml |');
      expect(d.markdown).toContain('| (a) Representative | EU Rep, To complete | declared: compliance.yaml |');
    });

    it('joint-controllers: absent, or an entry written "to complete"', () => {
      const dir = copy();
      edit(dir, TB, 'joint_controllers: []', 'joint_controllers:\n  - {name: Partner Restaurants, contact: to complete, arrangement: partners.pdf}');
      expect(counts(dir)['joint-controllers']).toBe(2);
      expect(section(md(dir), 'table-bookings')).toContain('| (a) Joint controller | Partner Restaurants, To complete (arrangement: partners.pdf) | declared: operations team |');
      expect(section(md(dir, 'fr'), 'table-bookings')).toContain('| (a) Responsable conjoint | Partner Restaurants, À compléter (accord: partners.pdf) | declared: operations team |');
    });

    it('personal-data: no personal data in scope (and the retention it leaves To complete)', () => {
      const dir = copy();
      edit(dir, ME, '    data: [newsletter-contacts]', '    data: []');
      edit(dir, ME, '    data: [guest-contact]', '    data: []');
      const c = counts(dir);
      expect(c['personal-data']).toBe(1);
      expect(c.retention).toBe(1);
      const s = section(md(dir), 'marketing-emails');
      expect(s).toContain('| (c) Personal data | To complete | — |');
      expect(s).toContain('| (f) Erasure time limits | To complete | — |');
    });

    it('personal-data: one open item per processing, whatever the number of unknown fields', () => {
      const dir = copy();
      edit(dir, API, '{name: guest name, category: identity}', '{name: guest name, category: unknown}');
      edit(dir, API, '{name: party size, category: usage}', '{name: party size, category: unknown}');
      expect(counts(dir)['personal-data']).toBe(2);
      expect(buildDossier(dir, GENERATED_AT, 'en').actions.find((a) => a.id === 'personal-data')).toEqual({ id: 'personal-data', role: 'developer', count: 2 });
    });

    it('processor-contracts: dpa unknown or no', () => {
      const dir = copy();
      edit(dir, API, '    country: NL\n    dpa: "yes"', '    country: NL\n    dpa: unknown');
      expect(counts(dir)['processor-contracts']).toBe(2);
      expect(md(dir)).toContain('| `processor-contracts`: Sign or locate the processor contracts (Art. 28) | Organisation | 2 | marketing-emails, table-bookings |');
      expect(section(md(dir), 'table-bookings')).toContain('| | TextFlow SMS (NL): DPA unknown (TextFlow SMS data processing agreement, signed 2025-09-02) | code: bistro-api@7c1e4f9:src/notifications/sms.ts |');
    });

    it('retention: the processing retention unknown, or one per storage unknown', () => {
      const dir = copy();
      edit(dir, TB, '  duration: P3Y', '  duration: unknown');
      edit(dir, API, 'retention: {duration: P30D, trigger: log rotation}', 'retention: {duration: unknown, trigger: log rotation}');
      // table-bookings: its own retention; marketing-emails: campaign-exports and app-logs.
      expect(counts(dir).retention).toBe(3);
      expect(section(md(dir), 'table-bookings')).toContain('| (f) Erasure time limits | unknown, after the last booking of the guest | declared: records of processing policy |');
    });

    it('security-measures: none stated', () => {
      const dir = copy();
      edit(dir, TB, /security_measures:\n(  - .*\n)+/.exec(readFileSync(join(dir, TB), 'utf8'))![0], '');
      expect(counts(dir)['security-measures']).toBe(2);
      expect(section(md(dir), 'table-bookings')).toContain('| (g) Security measures | To complete | — |');
    });

    it('legal-basis-detail: absent, a text written "to complete", or not expected', () => {
      const dir = copy();
      edit(dir, TB, '  reference: "Booking terms', '  reference: "to complete"\n  consent: {collection: c, withdrawal: w}\n  # "Booking terms');
      expect(counts(dir)['legal-basis-detail']).toBe(2);
      expect(section(md(dir), 'table-bookings')).toContain('| Legal basis detail | Reference: To complete | declared: operations team |');

      edit(dir, ME, 'legal_basis: consent', 'legal_basis: legitimate-interests\nlegal_basis_detail:\n  balancing_test: {interest: i, necessity: n, impact: m, safeguards: s}');
      const s = section(md(dir), 'marketing-emails');
      expect(s).toContain('| Legal basis detail | Interest: i | declared: marketing team |\n| | Necessity: n | declared: marketing team |\n| | Impact: m | declared: marketing team |\n| | Safeguards: s | declared: marketing team |');
      expect(counts(dir)['legal-basis-detail']).toBe(1);

      edit(dir, ME, 'legal_basis: legitimate-interests', 'legal_basis: not-applicable');
      expect(section(md(dir), 'marketing-emails')).toContain('| Legal basis detail | Not expected for this legal basis | — |');
      expect(counts(dir)['legal-basis-detail']).toBe(1);
    });

    it('dpia: absent, to-assess, or required without a reference; not when required is no', () => {
      const dir = copy();
      edit(dir, TB, '  ref: "DPIA-2026-01, table bookings (dpia/table-bookings.pdf)"\n', '');
      expect(counts(dir).dpia).toBe(2);
      expect(section(md(dir), 'table-bookings')).toContain('| DPIA | Required: yes; Criteria: evaluation, sensitive; Reference: To complete | declared: operations team |');
      edit(dir, TB, '  required: "yes"\n  criteria: [evaluation, sensitive]', '  required: "no"\n  criteria: []');
      expect(counts(dir).dpia).toBe(1);
      expect(section(md(dir, 'fr'), 'table-bookings')).toContain('| AIPD | Requise: no; Critères: Aucun | declared: operations team |');
      edit(dir, ME, 'dpia:\n  required: to-assess\n', '');
      expect(counts(dir).dpia).toBe(1);
      expect(section(md(dir), 'marketing-emails')).toContain('| DPIA | To complete | — |');
    });

    it('information: absent, or one per notice of kind none', () => {
      const dir = copy();
      edit(dir, WEB, '    kind: page', '    kind: none');
      expect(counts(dir).information).toBe(2);
      expect(md(dir)).toContain('| `information`: State how the persons are informed (Art. 13 and 14) | Organisation | 2 | marketing-emails, table-bookings |');
      expect(section(md(dir), 'table-bookings')).toContain('| Information of persons | none: https://bistro-booking.example/privacy (bistro-web) | code: bistro-web@9d3f6b1:src/pages/privacy.tsx |');
    });

    it('sensitive-data: absent or to-assess; none is a value', () => {
      const dir = copy();
      edit(dir, ME, 'sensitive_data: to-assess', 'sensitive_data: none');
      expect(counts(dir)['sensitive-data']).toBeUndefined();
      edit(dir, ME, 'sensitive_data: none\n', '');
      expect(counts(dir)['sensitive-data']).toBe(1);
      expect(section(md(dir), 'marketing-emails')).toContain('| Sensitive data | To complete | — |');
    });

    it('transfer-safeguards: a transfer without safeguard, or a destination to assess', () => {
      const dir = copy();
      edit(dir, API, '    safeguard: "The guest adds the booking to a calendar of their choice with their own account; the service only offers the link."\n', '');
      expect(counts(dir)['transfer-safeguards']).toBe(2);
      expect(section(md(dir), 'table-bookings')).toContain('| | the calendar application chosen by the guest (country unknown): destination to assess | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |');
      expect(section(md(dir, 'fr'), 'table-bookings')).toContain('| | the calendar application chosen by the guest (pays inconnu): destination à évaluer | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |');
    });

    it('ai-classification and ai-obligations: role, risk, open and expected obligations', () => {
      const dir = copy();
      edit(dir, API, 'risk: {level: limited, reason: "The score', 'risk: {level: prohibited, reason: "The score');
      edit(dir, API, '    role: to-assess\n    risk: {level: limited, reason: "A chat assistant that talks to guests: transparency obligations only."}', '    role: deployer\n    risk: {level: high}');
      const c = counts(dir);
      // no-show-prediction: prohibited; booking-assistant: classified.
      expect(c['ai-classification']).toBe(1);
      // no-show: art4 open; assistant: art50-synthetic-content, 7 high-risk ones, art26 and art27.
      expect(c['ai-obligations']).toBe(11);
      const row = md(dir).split('\n').find((l) => l.startsWith('| bistro-api | booking-assistant:'))!;
      expect(row).toContain('| deployer | high | art10-data-governance: To complete; art11-technical-documentation: To complete;');
      expect(row).toContain('art27-fria: To complete; art4-ai-literacy: done (AI training of the support team, 2026); art50-interaction: done');
      expect(row).toContain('art9-risk-management: To complete | code: bistro-api@7c1e4f9:src/assistant/chat.ts |');
    });

    it('ai features of a manifest no processing refers to are not shown', () => {
      const dir = copy();
      edit(dir, TB, '  - repo: bistro-api\n    data: [guest-contact, booking-details, payment-reference, no-show-history, request-metadata]\n    recipients: [calendar-link, charge-deposit, mailrelay, paygate, send-email, send-sms, textflow-sms]\n', '');
      edit(dir, ME, '  - repo: bistro-api\n    data: [guest-contact]\n    recipients: []\n', '');
      const m = md(dir);
      expect(m).toContain('\nNo AI feature in the services of the processing activities.\n');
      expect(counts(dir)['ai-obligations']).toBeUndefined();
    });

    it('controller-rationale: once per service, whatever its number of rows', () => {
      const dir = copy();
      edit(dir, WEB, '  controller: organisation\n  controller_rationale: "The offline app', '  controller: shared\n  # "The offline app');
      const c = counts(dir);
      expect(c['controller-rationale']).toBe(2); // crm and bistro-web
      const m = md(dir);
      expect(m).toContain('\n3 services or components whose controller is not the organisation alone.\n');
      expect(m).toContain('| bistro-web | shared | To complete | Favourites and notes of the offline app never leave the device; Page views are sent only after the visitor has consented; The offline app works without an account | booking-form (contact, identity, special); visit-statistics (usage) | declared: services/bistro-web/manifest.yaml (README.md) |');
      expect(m).toContain('| bistro-web/offline-app | user-of-the-app | To complete |');
    });

    it('takes free text that only looks like a gap as a value', () => {
      const dir = copy();
      edit(dir, ME, 'purpose: Send', 'purpose: To complete our offers, send');
      edit(dir, API, 'safeguard: standard contractual clauses', 'safeguard: "SCC, safeguard not declared"');
      expect(counts(dir)).toEqual(EXAMPLE_ACTIONS);
    });
  });

  describe('recipients and transfers: flows merged with their processors', () => {
    it('gives one row per processor, whether a flow names it by id or by name and country', () => {
      const s = section(golden.en, 'table-bookings');
      expect(s).toContain('| (d) Recipients | MailRelay (FR): DPA yes | code: bistro-api@7c1e4f9:src/notifications/email.ts |\n| | PayGate (US): DPA yes | code: bistro-api@7c1e4f9:src/payments/deposit.ts |\n| | TextFlow SMS (NL): DPA yes | code: bistro-api@7c1e4f9:src/notifications/sms.ts |\n| | the calendar application chosen by the guest (country unknown) | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |\n| (e) Transfers');
      const dir = copy();
      edit(dir, API, 'to: {name: PayGate, country: US}', 'to: {name: PayGate Inc, country: US}');
      expect(section(md(dir), 'table-bookings')).not.toContain('PayGate Inc');
    });

    it('brings the processor of an in-scope flow into scope, even when recipients does not name it', () => {
      const dir = copy();
      edit(dir, TB, 'recipients: [calendar-link, charge-deposit, mailrelay, paygate, send-email, send-sms, textflow-sms]', 'recipients: [charge-deposit]');
      const s = section(md(dir), 'table-bookings');
      expect(s).toContain('| (d) Recipients | MailRelay (email confirmations) | declared: services/bistro-api/manifest.yaml |\n| | PayGate (US): DPA yes | code: bistro-api@7c1e4f9:src/payments/deposit.ts |\n| | TextFlow SMS (SMS reminders) | declared: services/bistro-api/manifest.yaml |\n| (e) Transfers | PayGate (US): standard contractual clauses | code: bistro-api@7c1e4f9:src/payments/deposit.ts |\n| (f)');
      expect(s).toContain('| Processor contracts | PayGate (US): DPA yes (PayGate data processing addendum, signed 2025-11-20) | code: bistro-api@7c1e4f9:src/payments/deposit.ts |\n');
    });

    it('takes the safeguard of the flow first, with the flow as source', () => {
      const dir = copy();
      edit(dir, API, '    processor: paygate\n', '    processor: paygate\n    safeguard: binding corporate rules\n');
      edit(dir, API, '    source: {kind: code, ref: "src/payments/deposit.ts"}\n\n  - id: calendar-link', '    source: {kind: code, ref: "src/payments/charge.ts"}\n\n  - id: calendar-link');
      const s = section(md(dir), 'table-bookings');
      expect(s).toContain('| (e) Transfers | PayGate (US): binding corporate rules | code: bistro-api@7c1e4f9:src/payments/charge.ts |\n| | PayGate (US): standard contractual clauses | code: bistro-api@7c1e4f9:src/payments/deposit.ts |\n');
    });

    it('a flow to a third country with no processor and no safeguard: safeguard not declared', () => {
      const dir = copy();
      edit(dir, API, 'to: {name: the calendar application chosen by the guest, country: unknown}', 'to: {name: CalendarCloud, country: US}');
      edit(dir, API, '    safeguard: "The guest adds the booking to a calendar of their choice with their own account; the service only offers the link."\n', '');
      const s = section(md(dir), 'table-bookings');
      expect(s).toContain('| (e) Transfers | CalendarCloud (US): safeguard not declared | code: bistro-api@7c1e4f9:src/bookings/calendar.ts |');
      expect(counts(dir)['transfer-safeguards']).toBe(2);
    });
  });

  it('reads a v0.1 processing file in a v0.2 repo: each missing v0.2 field is an open item', () => {
    const dir = copy();
    writeFileSync(
      join(dir, TB),
      [
        'spec_version: "0.1"',
        'id: table-bookings',
        'name: Table bookings',
        'purpose: Take, confirm, remind and secure table bookings made by guests.',
        'controller: {name: Bistro Booking Group, contact: privacy@bistro-booking.example}',
        'data_subjects: [restaurant guests]',
        'legal_basis: contract',
        'services:',
        '  - repo: bistro-web',
        '    data: [booking-form]',
        '    recipients: []',
        'security_measures:',
        '  - {measure: Data encrypted in transit (TLS) and at rest, source: {kind: declared, ref: "docs/security.md"}}',
        'retention: {duration: P3Y, source: {kind: declared, ref: "records of processing policy"}}',
        'source: {kind: declared, ref: "operations team"}',
        '',
      ].join('\n'),
    );
    const c = counts(dir);
    for (const kind of ['joint-controllers', 'legal-basis-detail', 'dpia', 'information', 'sensitive-data']) expect(c[kind]).toBe(2);
    const s = section(md(dir), 'table-bookings');
    expect(s).toContain('| (a) Joint controller | To complete | — |');
    expect(s).toContain('| DPIA | To complete | — |');
    // The v0.1 CRM manifest of the example: no rationale, no privacy by design.
    expect(golden.en).toContain('| crm | shared | To complete | None identified in the sources | newsletter-contacts (contact, identity, unknown, usage) | declared: declared/crm/manifest.yaml (marketing team) |');
  });

  it('escapes cells and keeps names verbatim in the headings', () => {
    const dir = copy();
    edit(dir, TB, 'name: Table bookings', 'name: "Table | bookings"');
    edit(dir, TB, 'purpose: Take, confirm, remind and secure table bookings made by guests.', 'purpose: "  Take\\nconfirm |  "');
    const m = md(dir);
    expect(m).toContain('\n## Table \\| bookings (table-bookings)\n');
    expect(m).toContain('| (b) Purposes | Take confirm \\| | declared: operations team |');
  });

  describe('fails, and writes nothing', () => {
    it('when a notice does not resolve', () => {
      const dir = copy();
      edit(dir, TB, '{repo: bistro-web, id: privacy-page}', '{repo: bistro-web, id: ghost}');
      expect(() => md(dir)).toThrow(/no notice "ghost" in services\/bistro-web\/manifest\.yaml/);
      edit(dir, TB, '{repo: bistro-web, id: ghost}', '{tool: payroll, id: ghost}');
      expect(() => md(dir)).toThrow(/tool "payroll" is not listed/);
    });

    it('when a repo with a services/ folder has no manifest or no sync, even if no processing uses it', () => {
      const dir = copy();
      mkdirSync(join(dir, 'services/bistro-analytics'));
      expect(() => md(dir)).toThrow(/services\/bistro-analytics\/manifest\.yaml not found/);
      cpSync(join(dir, 'services/bistro-web/manifest.yaml'), join(dir, 'services/bistro-analytics/manifest.yaml'));
      expect(() => md(dir)).toThrow(/services\/bistro-analytics\/sync\.yaml not found/);
    });

    it('when a declared tool has no manifest', () => {
      const dir = copy();
      rmSync(join(dir, 'declared/crm/manifest.yaml'));
      expect(() => md(dir)).toThrow(/declared\/crm\/manifest\.yaml not found/);
    });

    it('when a v0.2 file is invalid, or a v0.1 file holds a v0.2 field', () => {
      const dir = copy();
      edit(dir, API, '    processor: paygate', '    processor: ghost');
      expect(() => md(dir)).toThrow(/manifest\.yaml is invalid: \/outbound_flows\/2\/processor: no processor with id "ghost"/);
      const other = copy();
      edit(other, 'declared/crm/manifest.yaml', '  controller: shared\n', '  controller: shared\n  controller_rationale: co-edited\n');
      expect(() => md(other)).toThrow(/declared\/crm\/manifest\.yaml is invalid/);
    });

    it('when the v0.1 generator meets a v0.2 processing file, or a v0.2 compliance.yaml', () => {
      const dir = tmp('ca-register-');
      cpSync(EXAMPLE, dir, { recursive: true });
      cpSync(join(EXAMPLE_V02, TB), join(dir, TB));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/processing\.yaml is spec_version "0\.2" but compliance\.yaml is "0\.1"/);
      expect(() => buildRegister(EXAMPLE_V02, GENERATED_AT)).toThrow(/spec_version "0\.2"/);
      expect(() => buildDossier(EXAMPLE, GENERATED_AT, 'en')).toThrow(/needs "0\.2"/);
    });
  });
});

describe('mode register, v0.2 compliance repo', () => {
  const ctx: EventContext = { eventName: 'push', ref: 'refs/heads/main', sha: 'c'.repeat(40), repo: { owner: 'bistro-org', repo: 'bistro-compliance' }, payload: {} };
  const run = (o: Pick<RegisterOptions, 'compliancePath' | 'api'> & Partial<RegisterOptions>) => runRegister({ baseBranch: 'main', token: TOKEN, ctx, generatedAt: GENERATED_AT, ...o });

  function bare(example = EXAMPLE_V02): { dir: string; remote: string } {
    const r = complianceRepo(example);
    git(r.dir, 'rm', '-rq', 'documents', 'anchors.yaml');
    git(r.dir, 'commit', '-q', '-m', 'drop generated files');
    git(r.dir, 'push', '-q', 'origin', 'main');
    return r;
  }

  it('writes the dossier and a v0.2 anchors.yaml, and lists the actions in the pull request as code spans', async () => {
    const { dir } = bare();
    const api = mockApi();
    await run({ compliancePath: dir, api });
    expect(readFileSync(join(dir, 'documents/register.md'), 'utf8')).toBe(golden.en);
    expect(readFileSync(join(dir, 'anchors.yaml'), 'utf8')).toBe(readFileSync(join(EXAMPLE_V02, 'anchors.yaml'), 'utf8'));
    expect(git(dir, 'diff', '--name-only', 'origin/main', 'HEAD').split('\n').sort()).toEqual(['anchors.yaml', 'documents/register.md']);

    const body = (api.createPullRequest.mock.calls[0][1] as { body: string }).body;
    expect(body).toContain('Compliance dossier');
    expect(body).toContain('does not certify compliance with the GDPR or the AI Act');
    expect(body).toContain('- Open items: 15 open items, closed by 14 actions.\n  - `information`: `State how the persons are informed (Art. 13 and 14)` (`Organisation`, 1)\n');
    expect(body).toContain('  - `ai-obligations`: `Meet or document the AI Act obligations` (`Developer`, 2)\n');
    const actionLines = body.split('\n').filter((l) => l.startsWith('  - '));
    expect(actionLines).toHaveLength(14);
    for (const l of actionLines) expect(l).toMatch(/^ {2}- `[a-z-]+`: `[^`\n]+` \(`[^`\n]+`, \d+\)$/);
    expect(body).not.toContain(TOKEN);
  });

  it('writes the French dossier at the same path with language fr; the pull request stays in English', async () => {
    const { dir } = bare();
    const api = mockApi();
    await run({ compliancePath: dir, api, language: 'fr' });
    expect(readFileSync(join(dir, 'documents/register.md'), 'utf8')).toBe(golden.fr);
    const body = (api.createPullRequest.mock.calls[0][1] as { body: string }).body;
    expect(body).toContain('in French');
    expect(body).toContain('(`Organisation`, 1)');
  });

  it('refuses an unknown language before touching anything', async () => {
    const { dir, remote } = bare();
    const api = mockApi();
    await expect(run({ compliancePath: dir, api, language: 'de' })).rejects.toThrow(/Unknown language "de"/);
    expect(git(remote, 'branch', '--list')).not.toMatch(/compliance\/register/);
    expect(api.findOpenPullRequest).not.toHaveBeenCalled();
  });

  it('does nothing when the dossier is up to date, even on a later commit; a change of language regenerates it', async () => {
    const { dir, remote } = complianceRepo(EXAMPLE_V02); // main holds the English dossier and anchors.yaml
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'later', '--date=2030-01-01T00:00:00+00:00');
    git(dir, 'push', '-q', 'origin', 'main');
    const api = mockApi();
    await run({ compliancePath: dir, api, generatedAt: undefined });
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(git(remote, 'branch', '--list')).not.toMatch(/compliance\/register/);

    await run({ compliancePath: dir, api, language: 'fr' });
    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'documents/register.md'), 'utf8')).toBe(golden.fr);
  });

  it('a v0.1 compliance repo keeps its v0.1 register, byte for byte, whatever the language', async () => {
    const { dir } = bare(EXAMPLE);
    const api = mockApi();
    await run({ compliancePath: dir, api, language: 'fr' });
    expect(readFileSync(join(dir, 'documents/register.md'), 'utf8')).toBe(goldenV01);
    expect(readFileSync(join(dir, 'anchors.yaml'), 'utf8')).toBe(readFileSync(join(EXAMPLE, 'anchors.yaml'), 'utf8'));
    const body = (api.createPullRequest.mock.calls[0][1] as { body: string }).body;
    expect(body.startsWith('Records of processing activities (GDPR Art. 30(1)) generated from the compliance repo.\n')).toBe(true);
    expect(body).toContain('It does not certify compliance with the GDPR. Open items are listed first in the register:');
  });
});

describe('refusals that keep the dossier from looking complete', () => {
  it('refuses a repo and a declared tool with the same name', () => {
    const dir = copy(false);
    const file = join(dir, 'compliance.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - name: bistro-web\n', '  - name: crm\n    url: https://github.com/bistro-org/crm\n    owner: marketing team\n    expected_to_send: true\n  - name: bistro-web\n'));
    expect(() => buildDossier(dir, GENERATED_AT, 'en')).toThrow(/"crm" is both a repo and a declared tool/);
  });

  it('refuses a symbolic link under processings/, even a dangling one', () => {
    const dir = copy(false);
    symlinkSync('/nonexistent', join(dir, 'processings', 'ghost'));
    expect(() => buildDossier(dir, GENERATED_AT, 'en')).toThrow(/processings\/ghost is a symbolic link/);
    const dir2 = copy(false);
    mkdirSync(join(dir2, 'processings', 'ghost'));
    symlinkSync('/nonexistent', join(dir2, 'processings', 'ghost', 'processing.yaml'));
    expect(() => buildDossier(dir2, GENERATED_AT, 'en')).toThrow(/symbolic link/);
  });

  it('a v0.1 register refuses a v0.2 manifest instead of ignoring its fields', () => {
    const dir = tmp('ca-v01-');
    cpSync(EXAMPLE, dir, { recursive: true });
    const file = join(dir, 'services/bistro-api/manifest.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('spec_version: "0.1"', 'spec_version: "0.2"'));
    expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/is spec_version "0.2" but compliance.yaml is "0.1"/);
  });
});
