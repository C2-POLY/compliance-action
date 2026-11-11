import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { runCheck } from '../src/check.js';
import { SPEC_URL } from '../src/errors.js';
import { FIXTURES, logged } from './helpers.js';

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const dir = join(FIXTURES, 'manifests');

describe('mode check', () => {
  it('passes on a valid manifest and logs the schema version', () => {
    expect(() => runCheck(join(dir, 'valid.yaml'))).not.toThrow();
    expect(core.error).not.toHaveBeenCalled();
    expect(vi.mocked(core.info).mock.calls.flat().join('\n')).toContain('schema v0.1');
  });

  it('passes on the full Bistro Booking example manifests', () => {
    expect(() => runCheck(join(FIXTURES, 'bistro-booking/services/bistro-api/manifest.yaml'))).not.toThrow();
    expect(() => runCheck(join(FIXTURES, 'bistro-booking/services/bistro-web/manifest.yaml'))).not.toThrow();
  });

  const invalid = readdirSync(dir).filter((f) => f.startsWith('invalid-'));
  it('has invalid fixtures', () => expect(invalid.length).toBeGreaterThanOrEqual(5));

  for (const file of invalid) {
    it(`fails on ${file} and annotates the field and the error`, () => {
      const path = join(dir, file);
      const [, instancePath] = /^# expect: (\S+) (\S+)/.exec(readFileSync(path, 'utf8'))!;
      expect(() => runCheck(path)).toThrow(/not a valid manifest/);
      const calls = vi.mocked(core.error).mock.calls;
      const hit = calls.find(([message]) => String(message).startsWith(`${instancePath}:`));
      expect(hit, `no annotation for ${instancePath}: ${JSON.stringify(calls)}`).toBeDefined();
      expect(String(hit![0]).length).toBeGreaterThan(instancePath.length + 2);
      expect(hit![1]).toMatchObject({ file: path, title: expect.any(String) });
    });
  }

  it('fails with a pointer to the spec when the file is missing', () => {
    expect(() => runCheck(join(dir, 'nope.yaml'))).toThrow(/not found/);
    expect(() => runCheck(join(dir, 'nope.yaml'))).toThrow(SPEC_URL);
  });

  it('fails on broken YAML', () => {
    expect(() => runCheck(join(FIXTURES, 'broken.txt'))).toThrow(/not a valid manifest/);
    expect(logged().join('\n')).toContain('YAML syntax error');
  });
});
