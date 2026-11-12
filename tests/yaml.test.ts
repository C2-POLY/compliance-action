import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/check.js';
import { runReceive } from '../src/receive.js';
import { runSend } from '../src/send.js';
import { FIXTURES, complianceRepo, git, initRepo, mockApi, tmp, write } from './helpers.js';

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const valid = readFileSync(join(FIXTURES, 'manifests', 'valid.yaml'), 'utf8');

const bad: Record<string, string> = {
  'a !!python/object/apply tag': 'a: !!python/object/apply:os.system ["id"]\n',
  'a %YAML 1.1 directive with a merge key': '%YAML 1.1\n---\nbase: &b {x: 1}\nother:\n  <<: *b\n',
  'an alias': 'a: &x [1, 2]\nb: *x\n',
  'a custom !foo tag': 'a: !foo bar\n',
  'an anchor without alias': 'a: &x 1\n',
  'an explicit %YAML 1.2 directive': '%YAML 1.2\n---\na: 1\n',
  'a %TAG directive': '%TAG !e! tag:example.com,2026:\n---\na: 1\n',
  'a standard tag': 'a: !!str 1\n',
  'two documents': 'a: 1\n---\nb: 2\n',
  'a duplicate key': 'a: 1\na: 2\n',
};

// The parser itself is tested in @c2-poly/compliance-core: these tests hold each mode to it.
describe('strict YAML', () => {
  it('check rejects each of them', () => {
    for (const text of Object.values(bad)) {
      const dir = tmp();
      write(dir, 'm.yaml', text);
      expect(() => runCheck(join(dir, 'm.yaml'))).toThrow(/not a valid manifest/);
    }
  });

  it('check rejects a valid manifest that gains an alias', () => {
    const dir = tmp();
    write(dir, 'm.yaml', `${valid}\nextra: &a 1\nmore: *a\n`);
    expect(() => runCheck(join(dir, 'm.yaml'))).toThrow(/not a valid manifest/);
  });

  it('send rejects them before any request', async () => {
    const dir = tmp();
    write(dir, 'm.yaml', `${valid}\nx: !foo bar\n`);
    const api = mockApi();
    await expect(
      runSend({
        manifestPath: join(dir, 'm.yaml'),
        complianceRepo: 'bistro-org/bistro-compliance',
        baseBranch: 'main',
        ctx: { eventName: 'push', ref: 'refs/heads/main', sha: 'a'.repeat(40), repo: { owner: 'bistro-org', repo: 'bistro-api' }, payload: {} },
        api,
        cwd: initRepo(),
      }),
    ).rejects.toThrow(/not a valid manifest/);
    expect(api.dispatch).not.toHaveBeenCalled();
  });

  it('receive rejects them and writes nothing', async () => {
    const { dir } = complianceRepo();
    const manifest = `${valid}\nx: !foo bar\n`;
    await expect(
      runReceive({
        compliancePath: dir,
        baseBranch: 'main',
        manifestPath: '.compliance/manifest.yaml',
        token: 'ghs_x',
        verifySource: false,
        ctx: {
          eventName: 'repository_dispatch',
          ref: 'refs/heads/main',
          sha: 'c'.repeat(40),
          repo: { owner: 'bistro-org', repo: 'bistro-compliance' },
          payload: { action: 'compliance-manifest', client_payload: { repo: 'bistro-org/bistro-api', sha: 'a'.repeat(40), manifest, lag: { status: 'unknown' } } },
        },
        api: mockApi(),
      }),
    ).rejects.toThrow(/invalid/);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
