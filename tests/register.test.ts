import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { anchorsYaml, buildRegister } from '@c2-poly/compliance-core';
import { loadDirectory } from '@c2-poly/compliance-core/fs';
import { BOT_EMAIL } from '../src/bot.js';
import { computeLag } from '../src/lag.js';
import { runRegister, type RegisterOptions } from '../src/register.js';
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

// The register itself is built and tested in @c2-poly/compliance-core: these tests hold the register mode to its golden.

describe('anchors and lag', () => {
  it('lets the lag of a service reset to 0 once the anchors are merged', async () => {
    const dir = exampleCopy(false);
    const service = initRepo();
    commit(service, 'src/bookings/guest.ts', 'export {};\n');
    const head = git(service, 'rev-parse', 'HEAD');
    const syncPath = join(dir, 'services/bistro-api/sync.yaml');
    writeFileSync(syncPath, readFileSync(syncPath, 'utf8').replace(/sha: "[0-9a-f]{40}"/, `sha: "${head}"`));

    const { anchors } = buildRegister(loadDirectory(dir), GENERATED_AT);
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
    expect(args.body).toContain('- Open items: 2 open items in 2 of the 2 processing activities.\n  - `Marketing emails (marketing-emails)`: `(g) Security measures`\n  - `Table bookings (table-bookings)`: `(e) Transfers: destination to assess');
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

  it('does nothing when a commit changes only what the register does not show (generated_at stays)', async () => {
    const { dir, remote } = complianceRepo(); // main already holds the generated files
    const before = readFileSync(join(dir, 'anchors.yaml'), 'utf8');
    write(dir, 'README.md', 'A compliance repo.\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'readme', '--date=2030-01-01T00:00:00+00:00');
    git(dir, 'push', '-q', 'origin', 'main');
    const api = mockApi();
    await run({ compliancePath: dir, api, generatedAt: undefined });
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(api.updatePullRequest).not.toHaveBeenCalled();
    expect(git(remote, 'branch', '--list')).not.toMatch(/compliance\/register/);
    expect(git(remote, 'rev-list', '--count', 'refs/heads/main')).toBe('2');
    expect(readFileSync(join(dir, 'anchors.yaml'), 'utf8')).toBe(before);
  });

  it('takes the new date when the content changes', async () => {
    const { dir } = complianceRepo();
    const previous = parse(readFileSync(join(dir, 'anchors.yaml'), 'utf8')).generated_at;
    write(dir, 'processings/table-bookings/processing.yaml', readFileSync(join(dir, 'processings/table-bookings/processing.yaml'), 'utf8').replace('Take, confirm', 'Take, change, confirm'));
    git(dir, 'commit', '-qam', 'edit purpose');
    git(dir, 'push', '-q', 'origin', 'main');
    const api = mockApi();
    await run({ compliancePath: dir, api, generatedAt: undefined });
    const now = parse(readFileSync(join(dir, 'anchors.yaml'), 'utf8')).generated_at;
    expect(now).not.toBe(previous);
    expect(now).toBe(git(dir, 'log', '-1', '--format=%cI', 'origin/main'));
    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
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
