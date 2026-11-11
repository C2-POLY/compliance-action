import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import anchors from '../schemas/v0.1/anchors.schema.json' with { type: 'json' };
import compliance from '../schemas/v0.1/compliance.schema.json' with { type: 'json' };
import manifest from '../schemas/v0.1/manifest.schema.json' with { type: 'json' };
import processing from '../schemas/v0.1/processing.schema.json' with { type: 'json' };
import sync from '../schemas/v0.1/sync.schema.json' with { type: 'json' };
import { parseStrict } from './yaml.js';
import source from '../schemas/SOURCE.json' with { type: 'json' };

export const SPEC_VERSION = source.spec_version;
export const SPEC_COMMIT = source.commit;

const SCHEMAS = { manifest, processing, compliance, sync, anchors };
export type SchemaName = keyof typeof SCHEMAS;

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
for (const [name, schema] of Object.entries(SCHEMAS)) ajv.addSchema(schema, name);

// Port of the cross-reference checks of compliance-spec/scripts/validate.mjs:
// rules JSON Schema cannot express (unique ids, `data` and `component` references).
function crossChecks(name: SchemaName, doc: unknown): ValidationError[] {
  if (name !== 'manifest' || typeof doc !== 'object' || doc === null) return [];
  const m = doc as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const errors: ValidationError[] = [];
  const fail = (instancePath: string, message: string) => errors.push({ instancePath, keyword: 'ref', message });
  const dataIds = new Set((m.personal_data ?? []).map((item: any) => item?.id)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const componentIds = new Set((m.service?.components ?? []).map((item: any) => item?.id)); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const list of ['personal_data', 'storage', 'processors', 'outbound_flows', 'automated_decisions', 'ai_features']) {
    const seen = new Set();
    (m[list] ?? []).forEach((item: any, i: number) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (seen.has(item?.id)) errors.push({ instancePath: `/${list}/${i}/id`, keyword: 'uniqueId', message: `duplicate id "${item.id}"` });
      seen.add(item?.id);
      (item?.data ?? []).forEach((ref: string, j: number) => {
        if (!dataIds.has(ref)) fail(`/${list}/${i}/data/${j}`, `no personal_data with id "${ref}"`);
      });
      if (item?.component !== undefined && !componentIds.has(item.component)) {
        fail(`/${list}/${i}/component`, `no service component with id "${item.component}"`);
      }
    });
  }
  return errors;
}

/** Validates an already parsed document. An empty list means valid. The root path is "/". */
export function validateDocument(name: SchemaName, doc: unknown): ValidationError[] {
  const validate = ajv.getSchema(name)!;
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
