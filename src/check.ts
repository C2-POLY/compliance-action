import { existsSync, readFileSync } from 'node:fs';
import * as core from '@actions/core';
import { validateText, versionOf } from '@c2-poly/compliance-core';
import { ActionError, SPEC_URL } from './errors.js';

/** Reads and validates the manifest. Annotates every error; throws ActionError if the manifest is missing or invalid. */
export function loadAndValidateManifest(path: string): string {
  if (!existsSync(path)) {
    throw new ActionError(`Manifest not found at "${path}". Create it as described in ${SPEC_URL}`);
  }
  const text = readFileSync(path, 'utf8');
  const { doc, errors } = validateText('manifest', text);
  if (errors.length > 0) {
    for (const e of errors) {
      core.error(`${e.instancePath}: ${e.message}`, { file: path, title: 'Invalid compliance manifest' });
    }
    throw new ActionError(`${path} is not a valid manifest: ${errors.length} error${errors.length === 1 ? '' : 's'} (see annotations).`);
  }
  core.info(`${path} is a valid manifest (schema v${versionOf(doc)}).`);
  return text;
}

export function runCheck(manifestPath: string): void {
  loadAndValidateManifest(manifestPath);
}
