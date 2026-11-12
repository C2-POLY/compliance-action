import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import anchors01 from '../schemas/v0.1/anchors.schema.json' with { type: 'json' };
import compliance01 from '../schemas/v0.1/compliance.schema.json' with { type: 'json' };
import manifest01 from '../schemas/v0.1/manifest.schema.json' with { type: 'json' };
import processing01 from '../schemas/v0.1/processing.schema.json' with { type: 'json' };
import sync01 from '../schemas/v0.1/sync.schema.json' with { type: 'json' };
import anchors02 from '../schemas/v0.2/anchors.schema.json' with { type: 'json' };
import compliance02 from '../schemas/v0.2/compliance.schema.json' with { type: 'json' };
import manifest02 from '../schemas/v0.2/manifest.schema.json' with { type: 'json' };
import processing02 from '../schemas/v0.2/processing.schema.json' with { type: 'json' };
import sync02 from '../schemas/v0.2/sync.schema.json' with { type: 'json' };
import { parseStrict } from './yaml.js';
import source from '../schemas/SOURCE.json' with { type: 'json' };

export const SPEC_COMMIT = source.commit;

const SCHEMAS = {
  '0.1': { manifest: manifest01, processing: processing01, compliance: compliance01, sync: sync01, anchors: anchors01 },
  '0.2': { manifest: manifest02, processing: processing02, compliance: compliance02, sync: sync02, anchors: anchors02 },
};
export type SchemaName = keyof (typeof SCHEMAS)['0.1'];
export type SpecVersion = keyof typeof SCHEMAS;
export const SPEC_VERSIONS = Object.keys(SCHEMAS) as SpecVersion[];

/** The schema version of a parsed file: its own spec_version when known, else "0.1" (which then reports the bad spec_version). */
export function versionOf(doc: unknown): SpecVersion {
  const v = (doc as { spec_version?: unknown } | null)?.spec_version;
  return typeof v === 'string' && v in SCHEMAS ? (v as SpecVersion) : '0.1';
}

export interface ValidationError {
  instancePath: string;
  keyword: string;
  message: string;
}

// ajv ships CommonJS: under some bundlers the constructor sits on `.default`.
const AjvCtor = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020) as typeof Ajv2020;
const addFormatsFn = ((addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats) as typeof addFormats;

const ajv = new AjvCtor({ allErrors: true });
addFormatsFn(ajv);
for (const [version, schemas] of Object.entries(SCHEMAS)) {
  for (const [name, schema] of Object.entries(schemas)) ajv.addSchema(schema, `${version}/${name}`);
}

// Port of the cross-reference checks of compliance-spec/scripts/validate.mjs:
// rules JSON Schema cannot express (unique ids, references between items of one manifest).
function crossChecks(name: SchemaName, doc: unknown): ValidationError[] {
  if (name !== 'manifest' || typeof doc !== 'object' || doc === null) return [];
  const m = doc as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const errors: ValidationError[] = [];
  const fail = (instancePath: string, message: string) => errors.push({ instancePath, keyword: 'ref', message });
  const duplicate = (instancePath: string, id: string) => errors.push({ instancePath, keyword: 'uniqueId', message: `duplicate id "${id}"` });
  const ids = (list: unknown): Set<unknown> => new Set(((list as any[]) ?? []).map((item: any) => item?.id)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const dataIds = ids(m.personal_data);
  const componentIds = ids(m.service?.components);
  const processorIds = ids(m.processors);
  const seenComponents = new Set();
  (m.service?.components ?? []).forEach((item: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (seenComponents.has(item?.id)) duplicate(`/service/components/${i}/id`, item.id);
    seenComponents.add(item?.id);
  });
  for (const list of ['personal_data', 'storage', 'processors', 'outbound_flows', 'automated_decisions', 'ai_features', 'notices']) {
    const seen = new Set();
    (m[list] ?? []).forEach((item: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (seen.has(item?.id)) duplicate(`/${list}/${i}/id`, item.id);
      seen.add(item?.id);
      (item?.data ?? []).forEach((ref: string, j: number) => {
        if (!dataIds.has(ref)) fail(`/${list}/${i}/data/${j}`, `no personal_data with id "${ref}"`);
      });
      if (item?.component !== undefined && !componentIds.has(item.component)) {
        fail(`/${list}/${i}/component`, `no service component with id "${item.component}"`);
      }
      if (list === 'outbound_flows' && item?.processor !== undefined && !processorIds.has(item.processor)) {
        fail(`/${list}/${i}/processor`, `no processor with id "${item.processor}"`);
      }
      if (list === 'ai_features') {
        const obligations = new Set();
        (item?.obligations ?? []).forEach((o: any, j: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          if (obligations.has(o?.id)) duplicate(`/${list}/${i}/obligations/${j}/id`, o.id);
          obligations.add(o?.id);
        });
      }
    });
  }
  return errors;
}

/** Validates an already parsed document against the schema of its own spec_version. An empty list means valid. The root path is "/". */
export function validateDocument(name: SchemaName, doc: unknown): ValidationError[] {
  const validate = ajv.getSchema(`${versionOf(doc)}/${name}`)!;
  const errors = validate(doc) ? [] : (validate.errors ?? []);
  return [...errors, ...crossChecks(name, doc)].map((e) => ({
    instancePath: e.instancePath || '/',
    keyword: e.keyword,
    message: e.message ?? 'invalid',
  }));
}

export interface Validated {
  doc: unknown;
  errors: ValidationError[];
}

/** Parses YAML text then validates it. A YAML syntax error is reported as a validation error. */
export function validateText(name: SchemaName, text: string): Validated {
  let doc: unknown;
  try {
    doc = parseStrict(text);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : 'invalid YAML';
    return { doc: undefined, errors: [{ instancePath: '/', keyword: 'yaml', message: `YAML syntax error: ${message}` }] };
  }
  return { doc, errors: validateDocument(name, doc) };
}
