import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { BOT_EMAIL } from '../src/bot.js';
import { computeLag } from '../src/lag.js';
import { anchorsYaml, buildRegister, runRegister, type RegisterOptions } from '../src/register.js';
import { validateDocument } from '../src/schema.js';
import { lagStatus } from '../src/types.js';
import type { EventContext } from '../src/types.js';
import { EXAMPLE, commit, complianceRepo, git, initRepo, mockApi, tmp, write } from './helpers.js';

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const GENERATED_AT = '2026-11-11T00:00:00Z';
const TOKEN = 'ghs_TESTTOKEN0123456789';
const golden = readFileSync(join(EXAMPLE, 'documents/register.md'), 'utf8');

/** A copy of the example without the generated files. */
function exampleCopy(withGenerated = true): string {
  const dir = tmp('ca-register-');
  cpSync(EXAMPLE, dir, { recursive: true });
  if (!withGenerated) {
    rmSync(join(dir, 'documents'), { recursive: true });
    rmSync(join(dir, 'anchors.yaml'));
  }
  return dir;
}

describe('buildRegister', () => {
  it('equals the golden register of the Bistro Booking example, byte for byte', () => {
    const { markdown } = buildRegister(EXAMPLE, GENERATED_AT);
    expect(markdown).toBe(golden);
  });

  it('gives identical output on two runs, and ignores the clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const a = buildRegister(EXAMPLE, GENERATED_AT);
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      const b = buildRegister(EXAMPLE, GENERATED_AT);
      expect(b).toEqual(a);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts a Source on every table row, and "—" only on To complete / None identified rows', () => {
    const rows = golden.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Item') && !l.startsWith('| ---'));
    expect(rows.length).toBeGreaterThan(30);
    const { markdown } = buildRegister(EXAMPLE, GENERATED_AT);
    const mine = markdown.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Item') && !l.startsWith('| ---'));
    expect(mine).toEqual(rows);
    for (const row of mine) {
      const cells = row.slice(1, -1).split(' | ').map((c) => c.trim());
      expect(cells).toHaveLength(3);
      const [, value, source] = cells;
      expect(source).not.toBe('');
      if (value === 'To complete' || value === 'None identified in the sources') expect(source).toBe('—');
      else expect(source).toMatch(/^(code: [\w.-]+@[0-9a-f]{7}:|spec: |declared: )/);
    }
    expect(markdown).toContain('| (a) Joint controller | To complete | — |');
  });

  it('returns the anchors, equal to the front matter and to the sync shas', () => {
    const { markdown, anchors } = buildRegister(EXAMPLE, GENERATED_AT);
    const front = parse(markdown.split('---\n')[1]);
    expect(front).toEqual({ spec_version: '0.1', generated_at: GENERATED_AT, anchors });
    for (const repo of Object.keys(anchors)) {
      const sync = parse(readFileSync(join(EXAMPLE, 'services', repo, 'sync.yaml'), 'utf8'));
      expect(anchors[repo]).toBe(sync.sha);
    }
    expect(Object.keys(anchors)).toEqual(['bistro-api', 'bistro-web']);
    // bistro-analytics has no processing, the CRM is a declared tool: neither is an anchor.
    expect(anchorsYaml(anchors, GENERATED_AT)).toBe(readFileSync(join(EXAMPLE, 'anchors.yaml'), 'utf8'));
    expect(validateDocument('anchors', parse(anchorsYaml(anchors, GENERATED_AT)))).toEqual([]);
  });

  it('writes `anchors: {}` when no processing refers to a repo', () => {
    const dir = exampleCopy();
    rmSync(join(dir, 'processings'), { recursive: true });
    const { markdown, anchors } = buildRegister(dir, GENERATED_AT);
    expect(anchors).toEqual({});
    expect(markdown.startsWith('---\nspec_version: "0.1"\ngenerated_at: "2026-11-11T00:00:00Z"\nanchors: {}\n---\n\n# Records')).toBe(true);
    expect(markdown).not.toContain('## ');
  });

  it('lets the lag of a service reset to 0 once the anchors are merged', async () => {
    const dir = exampleCopy(false);
    const service = initRepo();
    commit(service, 'src/bookings/guest.ts', 'export {};\n');
    const head = git(service, 'rev-parse', 'HEAD');
    const syncPath = join(dir, 'services/bistro-api/sync.yaml');
    writeFileSync(syncPath, readFileSync(syncPath, 'utf8').replace(/sha: "[0-9a-f]{40}"/, `sha: "${head}"`));

    const { anchors } = buildRegister(dir, GENERATED_AT);
    expect(anchors['bistro-api']).toBe(head);
    // "Merge": anchors.yaml lands in the compliance repo.
    const anchorsText = anchorsYaml(anchors, GENERATED_AT);
    const api = mockApi({ getFile: vi.fn(async (_r, path: string) => (path === 'anchors.yaml' ? anchorsText : null)) });
    const options = { api, complianceRepo: { owner: 'bistro-org', repo: 'bistro-compliance' }, repoName: 'bistro-api', sha: head, linkedFiles: ['src/bookings/**'], cwd: service };

    const synced = await computeLag(options);
    expect(synced).toMatchObject({ anchor: head, count: 0 });
    expect(lagStatus(synced)).toBe('in-sync');

    const next = commit(service, 'src/bookings/guest.ts', 'export const a = 1;\n');
    const behind = await computeLag({ ...options, sha: next });
    expect(behind).toMatchObject({ anchor: head, count: 1 });
    expect(lagStatus(behind)).toBe('behind');
  });

  describe('fails, and writes nothing', () => {
    it('when a processing points to a repo with no sync', () => {
      const dir = exampleCopy();
      rmSync(join(dir, 'services/bistro-web/sync.yaml'));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/services\/bistro-web\/sync\.yaml not found/);
    });

    it('when a processing points to a repo with no manifest', () => {
      const dir = exampleCopy();
      rmSync(join(dir, 'services/bistro-web/manifest.yaml'));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/services\/bistro-web\/manifest\.yaml not found/);
    });

    it('when a tool is not in compliance.yaml', () => {
      const dir = exampleCopy();
      const p = join(dir, 'processings/marketing-emails/processing.yaml');
      writeFileSync(p, readFileSync(p, 'utf8').replace('tool: crm', 'tool: payroll'));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/tool "payroll" is not listed/);
    });

    it('when a repo is not listed in compliance.yaml', () => {
      const dir = exampleCopy();
      const p = join(dir, 'processings/marketing-emails/processing.yaml');
      writeFileSync(p, readFileSync(p, 'utf8').replace('repo: bistro-api', 'repo: bistro-ghost'));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/repo "bistro-ghost" is not listed/);
    });

    it('when a data or recipients filter names an unknown id', () => {
      const dir = exampleCopy();
      const p = join(dir, 'processings/table-bookings/processing.yaml');
      writeFileSync(p, readFileSync(p, 'utf8').replace('textflow-sms]', 'ghost]'));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/no processor or outbound flow "ghost"/);
    });

    it('on an invalid file, a YAML alias, a symlink or a bad date', () => {
      const dir = exampleCopy();
      const p = join(dir, 'processings/table-bookings/processing.yaml');
      const original = readFileSync(p, 'utf8');
      writeFileSync(p, original.replace('legal_basis: contract', 'legal_basis: whatever'));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/processing\.yaml is invalid/);
      writeFileSync(p, original.replace('purpose: ', 'purpose: &a '));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/processing\.yaml is invalid/);
      writeFileSync(p, original);
      expect(() => buildRegister(dir, 'yesterday')).toThrow(/generated_at "yesterday" is not usable/);
      rmSync(join(dir, 'services/bistro-web/sync.yaml'));
      symlinkSync(join(dir, 'services/bistro-api/sync.yaml'), join(dir, 'services/bistro-web/sync.yaml'));
      expect(() => buildRegister(dir, GENERATED_AT)).toThrow(/symbolic link/);
    });
  });

  it('escapes cells: a newline becomes a space and | becomes \\|', () => {
    const dir = exampleCopy();
    const p = join(dir, 'processings/table-bookings/processing.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('purpose: Take, confirm, remind and secure table bookings made by guests.', 'purpose: "  Take bookings\\nand | more  "'));
    expect(buildRegister(dir, GENERATED_AT).markdown).toContain('| (b) Purposes | Take bookings and \\| more | declared: operations team |');
  });
});

describe('mode register', () => {
  const ctx: EventContext = {
    eventName: 'push',
    ref: 'refs/heads/main',
    sha: 'c'.repeat(40),
    repo: { owner: 'bistro-org', repo: 'bistro-compliance' },
    payload: {},
  };
  const run = (o: Pick<RegisterOptions, 'compliancePath' | 'api'> & Partial<RegisterOptions>) =>
    runRegister({ baseBranch: 'main', token: TOKEN, ctx, generatedAt: GENERATED_AT, ...o });

  /** A compliance repo on a bare remote whose main has no generated files yet. */
  function bareCompliance(): { dir: string; remote: string } {
    const r = complianceRepo();
    git(r.dir, 'rm', '-rq', 'documents', 'anchors.yaml');
    git(r.dir, 'commit', '-q', '-m', 'drop generated files');
    git(r.dir, 'push', '-q', 'origin', 'main');
    return r;
  }

  it('writes the files, pushes the bot branch and opens a pull request', async () => {
    const { dir, remote } = bareCompliance();
    const api = mockApi();
    await run({ compliancePath: dir, api });

    expect(readFileSync(join(dir, 'documents/register.md'), 'utf8')).toBe(golden);
    expect(readFileSync(join(dir, 'anchors.yaml'), 'utf8')).toBe(readFileSync(join(EXAMPLE, 'anchors.yaml'), 'utf8'));
    expect(git(remote, 'rev-parse', 'refs/heads/compliance/register')).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(git(dir, 'log', '-1', '--format=%an <%ae>|%s')).toBe(`compliance-action <${BOT_EMAIL}>|compliance: update the records of processing`);
    expect(git(dir, 'diff', '--name-only', 'origin/main', 'HEAD').split('\n').sort()).toEqual(['anchors.yaml', 'documents/register.md']);
    expect(git(remote, 'rev-list', '--count', 'refs/heads/main')).toBe('2');

    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
    const args = api.createPullRequest.mock.calls[0][1] as { head: string; base: string; title: string; body: string };
    expect(args).toMatchObject({ head: 'compliance/register', base: 'main', title: 'compliance: update the records of processing' });
    expect(args.body).toContain('does not certify compliance');
    expect(args.body).toContain('lag of each service');
    expect(args.body).not.toContain(TOKEN);
    expect(api.updatePullRequest).not.toHaveBeenCalled();
  });

  it('defaults generated_at to the commit time of the compliance repo, not the clock', async () => {
    const { dir } = bareCompliance();
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'dated', '--date=2026-05-05T10:00:00+00:00');
    // The committer date is what %cI reports.
    process.env.GIT_COMMITTER_DATE = '2026-05-05T10:00:00+00:00';
    try {
      git(dir, 'commit', '-q', '--allow-empty', '--amend', '--no-edit');
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
    }
    git(dir, 'push', '-q', 'origin', 'main');
    const expected = git(dir, 'log', '-1', '--format=%cI');
    await run({ compliancePath: dir, api: mockApi(), generatedAt: undefined });
    expect(parse(readFileSync(join(dir, 'anchors.yaml'), 'utf8')).generated_at).toBe(expected);
    expect(readFileSync(join(dir, 'documents/register.md'), 'utf8')).toContain(`generated_at: "${expected}"`);
  });

  it('a second run updates the existing pull request', async () => {
    const { dir, remote } = bareCompliance();
    const api = mockApi();
    await run({ compliancePath: dir, api });
    write(dir, 'processings/table-bookings/processing.yaml', readFileSync(join(dir, 'processings/table-bookings/processing.yaml'), 'utf8').replace('Take, confirm', 'Take, change, confirm'));
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'commit', '-qam', 'edit purpose');
    git(dir, 'push', '-q', 'origin', 'main');
    api.findOpenPullRequest.mockResolvedValueOnce({ number: 7, url: 'https://github.com/bistro-org/bistro-compliance/pull/7' });
    api.listPullRequestCommits.mockResolvedValueOnce([{ sha: git(remote, 'rev-parse', 'refs/heads/compliance/register'), authorEmail: BOT_EMAIL }]);
    await run({ compliancePath: dir, api });

    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
    expect(api.updatePullRequest).toHaveBeenCalledTimes(1);
    expect(api.updatePullRequest.mock.calls[0][1]).toBe(7);
    expect(readFileSync(join(dir, 'documents/register.md'), 'utf8')).toContain('Take, change, confirm');
    expect(git(remote, 'rev-parse', 'refs/heads/compliance/register')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('refuses when a human edited the branch', async () => {
    const { dir, remote } = bareCompliance();
    const api = mockApi();
    await run({ compliancePath: dir, api });
    const before = git(remote, 'rev-parse', 'refs/heads/compliance/register');
    api.findOpenPullRequest.mockResolvedValueOnce({ number: 7, url: 'u' });
    api.listPullRequestCommits.mockResolvedValueOnce([
      { sha: before, authorEmail: BOT_EMAIL },
      { sha: 'f'.repeat(40), authorEmail: 'human@example.com' },
    ]);
    git(dir, 'checkout', '-q', 'main');
    await expect(run({ compliancePath: dir, api, generatedAt: '2027-01-01T00:00:00Z' })).rejects.toThrow(/human edited the branch of pull request #7/);
    expect(git(remote, 'rev-parse', 'refs/heads/compliance/register')).toBe(before);
    expect(api.updatePullRequest).not.toHaveBeenCalled();
  });

  it('does nothing when the register is already up to date', async () => {
    const { dir, remote } = complianceRepo(); // main already holds the generated files
    const api = mockApi();
    await run({ compliancePath: dir, api });
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(api.updatePullRequest).not.toHaveBeenCalled();
    expect(git(remote, 'branch', '--list')).not.toMatch(/compliance\/register/);
    expect(git(remote, 'rev-list', '--count', 'refs/heads/main')).toBe('1');
  });

  it('fails without writing or pushing when a reference is unresolved', async () => {
    const { dir, remote } = bareCompliance();
    git(dir, 'rm', '-q', 'services/bistro-web/sync.yaml');
    git(dir, 'commit', '-q', '-m', 'drop sync');
    git(dir, 'push', '-q', 'origin', 'main');
    const api = mockApi();
    await expect(run({ compliancePath: dir, api })).rejects.toThrow(/sync\.yaml not found/);
    expect(git(remote, 'branch', '--list')).not.toMatch(/compliance\/register/);
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it('refuses to write through a symlink', async () => {
    const { dir } = bareCompliance();
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'documents'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'documents is a symlink');
    git(dir, 'push', '-q', 'origin', 'main');
    await expect(run({ compliancePath: dir, api: mockApi() })).rejects.toThrow(/symbolic link/);
  });
});
