import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runRegister, type RegisterOptions } from '../src/register.js';
import type { EventContext } from '../src/types.js';
import { EXAMPLE, EXAMPLE_V02, complianceRepo, git, mockApi } from './helpers.js';

// The dossier itself is built and tested in @c2-poly/compliance-core: these tests hold the register mode to its goldens.

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const GENERATED_AT = '2026-11-11T00:00:00Z';
const TOKEN = 'ghs_TESTTOKEN0123456789';
const golden = {
  en: readFileSync(join(EXAMPLE_V02, 'documents/register.md'), 'utf8'),
  fr: readFileSync(join(EXAMPLE_V02, 'documents/register.fr.md'), 'utf8'),
};
const goldenV01 = readFileSync(join(EXAMPLE, 'documents/register.md'), 'utf8');

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

  it('refuses a symbolic link under processings/, even a dangling one, and pushes nothing', async () => {
    const { dir, remote } = bare();
    symlinkSync('/nonexistent', join(dir, 'processings', 'ghost'));
    const api = mockApi();
    await expect(run({ compliancePath: dir, api })).rejects.toThrow(/processings\/ghost is a symbolic link/);
    expect(git(remote, 'branch', '--list')).not.toMatch(/compliance\/register/);
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });
});
