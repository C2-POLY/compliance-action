import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { BOT_EMAIL, runReceive, type ReceiveOptions } from '../src/receive.js';
import { validateDocument } from '../src/schema.js';
import type { EventContext } from '../src/types.js';
import { EXAMPLE, EXAMPLE_V02, complianceRepo, git, mockApi, tmp, write } from './helpers.js';
import { runGit, type GitRunner } from '../src/git.js';
import * as core from '@actions/core';
import { lstatSync, mkdirSync, readFileSync as rf, rmSync, symlinkSync } from 'node:fs';

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const TOKEN = 'ghs_TESTTOKEN0123456789';
const run = (o: Pick<ReceiveOptions, 'compliancePath' | 'ctx' | 'api'> & Partial<ReceiveOptions>) =>
  runReceive({ baseBranch: 'main', manifestPath: '.compliance/manifest.yaml', token: TOKEN, verifySource: true, ...o });
// An API where the sender repo agrees with the payload.
const okApi = (manifest?: string) => mockApi({ getFile: vi.fn(async () => manifest ?? apiManifest) });

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const apiManifest = readFileSync(join(EXAMPLE, 'services/bistro-api/manifest.yaml'), 'utf8');
const lag = { anchor: '4b8d2f6a0c1e9375a2d4f6b8c0e2a4d6f8b1c3e5', count: 1, commits: [SHA] };

const ctx = (clientPayload: Record<string, unknown>, over: Partial<EventContext> = {}): EventContext => ({
  eventName: 'repository_dispatch',
  ref: 'refs/heads/main',
  sha: 'c'.repeat(40),
  repo: { owner: 'bistro-org', repo: 'bistro-compliance' },
  payload: { action: 'compliance-manifest', client_payload: clientPayload },
  ...over,
});
const send = (over: Record<string, unknown> = {}) => ({ repo: 'bistro-org/bistro-api', sha: SHA, manifest: apiManifest, lag, ...over });

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.startsWith('.git')).sort();
}

describe('mode receive', () => {
  it('writes manifest and a valid sync.yaml, pushes the bot branch and opens a pull request', async () => {
    const { dir, remote } = complianceRepo();
    const api = okApi();
    await run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send()), api, now: () => new Date('2026-04-01T10:00:00Z') });

    expect(readFileSync(join(dir, 'services/bistro-api/manifest.yaml'), 'utf8')).toBe(apiManifest);
    const sync = parse(readFileSync(join(dir, 'services/bistro-api/sync.yaml'), 'utf8'));
    expect(sync).toEqual({ spec_version: '0.1', repo: 'bistro-api', sha: SHA, received_at: '2026-04-01T10:00:00.000Z', lag });
    expect(validateDocument('sync', sync)).toEqual([]);

    expect(git(remote, 'rev-parse', 'refs/heads/compliance/bistro-api')).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(git(dir, 'log', '-1', '--format=%an <%ae>|%s')).toBe(`compliance-action <${BOT_EMAIL}>|compliance: update bistro-api to a1b2c3d`);
    // main on the remote is untouched: nothing reaches it without a reviewed pull request.
    expect(git(remote, 'rev-list', '--count', 'refs/heads/main')).toBe('1');
    expect(git(remote, 'branch', '--list')).toMatch(/compliance\/bistro-api/);

    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
    expect(api.createPullRequest.mock.calls[0][1]).toMatchObject({
      head: 'compliance/bistro-api',
      base: 'main',
      title: 'compliance: update bistro-api to a1b2c3d',
    });
    expect(api.updatePullRequest).not.toHaveBeenCalled();
  });

  it('in a v0.2 compliance repo, accepts a v0.2 manifest and writes a v0.2 sync.yaml', async () => {
    const { dir } = complianceRepo(EXAMPLE_V02);
    const manifest = readFileSync(join(EXAMPLE_V02, 'services/bistro-api/manifest.yaml'), 'utf8');
    await run({ compliancePath: dir, ctx: ctx(send({ manifest })), api: okApi(manifest), now: () => new Date('2026-04-01T10:00:00Z') });
    expect(readFileSync(join(dir, 'services/bistro-api/manifest.yaml'), 'utf8')).toBe(manifest);
    const sync = parse(readFileSync(join(dir, 'services/bistro-api/sync.yaml'), 'utf8'));
    expect(sync).toEqual({ spec_version: '0.2', repo: 'bistro-api', sha: SHA, received_at: '2026-04-01T10:00:00.000Z', lag });
    expect(validateDocument('sync', sync)).toEqual([]);
  });

  it('in a v0.2 compliance repo, still accepts a v0.1 manifest, and rejects an invalid v0.2 one', async () => {
    const { dir } = complianceRepo(EXAMPLE_V02);
    await run({ compliancePath: dir, ctx: ctx(send()), api: okApi() });
    expect(readFileSync(join(dir, 'services/bistro-api/manifest.yaml'), 'utf8')).toBe(apiManifest);
    const bad = readFileSync(join(EXAMPLE_V02, 'services/bistro-api/manifest.yaml'), 'utf8').replace('processor: paygate', 'processor: ghost');
    await expect(run({ compliancePath: dir, ctx: ctx(send({ manifest: bad, sha: SHA2 })), api: okApi(bad) })).rejects.toThrow(/invalid/);
  });

  it('only changes files under services/<name>/', async () => {
    const { dir } = complianceRepo();
    await run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ manifest: `${apiManifest}\n# resent\n` })), api: okApi(`${apiManifest}\n# resent\n`) });
    const changed = git(dir, 'diff', '--name-only', 'origin/main', 'HEAD').split('\n');
    expect(changed.sort()).toEqual(['services/bistro-api/manifest.yaml', 'services/bistro-api/sync.yaml']);
  });

  it('a second run updates the existing pull request instead of creating one', async () => {
    const { dir, remote } = complianceRepo();
    const api = okApi();
    await run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send()), api });
    api.findOpenPullRequest.mockResolvedValueOnce({ number: 7, url: 'https://github.com/bistro-org/bistro-compliance/pull/7' });
    api.listPullRequestCommits.mockResolvedValueOnce([{ sha: git(remote, 'rev-parse', 'refs/heads/compliance/bistro-api'), authorEmail: BOT_EMAIL }]);
    await run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ sha: SHA2 })), api });

    expect(api.createPullRequest).toHaveBeenCalledTimes(1);
    expect(api.updatePullRequest).toHaveBeenCalledTimes(1);
    expect(api.updatePullRequest.mock.calls[0][1]).toBe(7);
    expect(api.updatePullRequest.mock.calls[0][2]).toMatchObject({ title: 'compliance: update bistro-api to b1b2c3d' });
    expect(git(remote, 'log', '-1', '--format=%s', 'refs/heads/compliance/bistro-api')).toBe('compliance: update bistro-api to b1b2c3d');
    expect(git(remote, 'rev-list', '--count', 'refs/heads/compliance/bistro-api')).toBe('2'); // reset from main, not stacked
  });

  it('rejects an invalid manifest and writes nothing', async () => {
    const { dir } = complianceRepo();
    const before = listing(dir);
    const api = okApi();
    await expect(run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ manifest: 'spec_version: "0.1"\n' })), api })).rejects.toThrow(/invalid/);
    expect(listing(dir)).toEqual(before);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it('rejects a repo that compliance.yaml does not list', async () => {
    const { dir } = complianceRepo();
    const api = okApi();
    await expect(run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ repo: 'bistro-org/bistro-ghost' })), api })).rejects.toThrow(/not listed in compliance\.yaml/);
    expect(existsSync(join(dir, 'services/bistro-ghost'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('rejects a listed name sent from another owner', async () => {
    const { dir } = complianceRepo();
    await expect(run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ repo: 'evil-org/bistro-api' })), api: okApi() })).rejects.toThrow(/does not match the URL/);
  });

  it('rejects a manifest whose service.repo is another repo', async () => {
    const { dir } = complianceRepo();
    const web = readFileSync(join(EXAMPLE, 'services/bistro-web/manifest.yaml'), 'utf8');
    await expect(run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ manifest: web })), api: okApi() })).rejects.toThrow(/service\.repo/);
  });

  for (const repo of ['bistro-org/../evil', 'bistro-org/..', 'bistro-org/.', '../evil', 'bistro-org/a/b', 'bistro-org/a b', 'bistro-org/evil%2f']) {
    it(`rejects the repo name "${repo}" and writes nothing`, async () => {
      const { dir } = complianceRepo();
      const before = listing(dir);
      await expect(run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ repo })), api: okApi() })).rejects.toThrow();
      expect(listing(dir)).toEqual(before);
      expect(existsSync(join(dir, '..', 'evil'))).toBe(false);
      expect(git(dir, 'status', '--porcelain')).toBe('');
    });
  }

  it('rejects a payload with a lag that is not a valid sync record', async () => {
    const { dir } = complianceRepo();
    await expect(run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ lag: { count: -1 } })), api: okApi() })).rejects.toThrow(/sync record/);
  });

  it('drops the lag "reason" (not part of the format) and accepts {status: unknown}', async () => {
    const { dir } = complianceRepo();
    await run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send({ lag: { status: 'unknown', reason: 'x' } })), api: okApi() });
    expect(parse(readFileSync(join(dir, 'services/bistro-api/sync.yaml'), 'utf8')).lag).toEqual({ status: 'unknown' });
  });

  it('rejects other events', async () => {
    const { dir } = complianceRepo();
    await expect(run({ compliancePath: dir, baseBranch: 'main', ctx: ctx(send(), { eventName: 'push' }), api: okApi() })).rejects.toThrow(/repository_dispatch/);
  });

  it('body labels the lag as reported by the service repo and the source as verified', async () => {
    const { dir } = complianceRepo();
    const api = okApi();
    await run({ compliancePath: dir, ctx: ctx(send()), api });
    const body = (api.createPullRequest.mock.calls[0][1] as { body: string }).body;
    expect(body).toContain('reported by the service repo');
    expect(body).toContain('Source verified');
  });

  describe('source verification', () => {
    it('fails and writes nothing when the manifest differs from the one at that sha', async () => {
      const { dir } = complianceRepo();
      const api = okApi(`${apiManifest}\n# something else\n`);
      await expect(run({ compliancePath: dir, ctx: ctx(send()), api })).rejects.toThrow(/differs from/);
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'branch', '--show-current')).toBe('main');
      expect(api.createPullRequest).not.toHaveBeenCalled();
    });

    it('fetches the manifest of the sender repo at the sent sha', async () => {
      const { dir } = complianceRepo();
      const api = okApi();
      await run({ compliancePath: dir, ctx: ctx(send()), api });
      expect(api.getFile).toHaveBeenCalledWith({ owner: 'bistro-org', repo: 'bistro-api' }, '.compliance/manifest.yaml', SHA);
      expect(api.isOnDefaultBranch).toHaveBeenCalledWith({ owner: 'bistro-org', repo: 'bistro-api' }, SHA);
    });

    it('fails when the file does not exist at that sha', async () => {
      const { dir } = complianceRepo();
      await expect(run({ compliancePath: dir, ctx: ctx(send()), api: mockApi() })).rejects.toThrow(/does not exist/);
    });

    it('fails when the sha is not on the default branch', async () => {
      const { dir } = complianceRepo();
      const api = okApi();
      api.isOnDefaultBranch.mockResolvedValue(false);
      await expect(run({ compliancePath: dir, ctx: ctx(send()), api })).rejects.toThrow(/not on the default branch/);
      expect(git(dir, 'status', '--porcelain')).toBe('');
    });

    it('fails with a clear message when the token cannot read the sender repo', async () => {
      const { dir } = complianceRepo();
      const api = mockApi({ getFile: vi.fn(async () => { throw Object.assign(new Error(`nope ${TOKEN}`), { status: 404 }); }) });
      const err = await run({ compliancePath: dir, ctx: ctx(send()), api }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/HTTP 404.*Contents: read/);
      expect((err as Error).message).not.toContain(TOKEN);
    });

    it('verify-source false skips both checks and says so in the PR body', async () => {
      const { dir } = complianceRepo();
      const api = mockApi(); // the sender repo would answer "not found"
      await run({ compliancePath: dir, ctx: ctx(send()), api, verifySource: false });
      expect(api.getFile).not.toHaveBeenCalled();
      expect(api.isOnDefaultBranch).not.toHaveBeenCalled();
      expect((api.createPullRequest.mock.calls[0][1] as { body: string }).body).toContain('Source not verified');
    });
  });

  describe('symbolic links', () => {
    function withSymlinks(mutate: (dir: string, outside: string) => void) {
      const c = complianceRepo();
      const outside = tmp('ca-outside-');
      write(outside, 'target.txt', 'original');
      mutate(c.dir, outside);
      git(c.dir, 'add', '-A');
      git(c.dir, 'commit', '-q', '-m', 'symlinks');
      git(c.dir, 'push', '-q', 'origin', 'main');
      return { ...c, outside };
    }
    const outsideIsUntouched = (outside: string) => {
      expect(readdirSync(outside).sort()).toEqual(['target.txt']);
      expect(rf(join(outside, 'target.txt'), 'utf8')).toBe('original');
    };

    it('refuses a symlinked services directory', async () => {
      const { dir, outside } = withSymlinks((d, o) => {
        rmSync(join(d, 'services'), { recursive: true });
        symlinkSync(o, join(d, 'services'));
      });
      await expect(run({ compliancePath: dir, ctx: ctx(send()), api: okApi() })).rejects.toThrow(/services is a symbolic link/);
      outsideIsUntouched(outside);
    });

    it('refuses a symlinked services/<name> directory', async () => {
      const { dir, outside } = withSymlinks((d, o) => {
        rmSync(join(d, 'services/bistro-api'), { recursive: true });
        symlinkSync(o, join(d, 'services/bistro-api'));
      });
      await expect(run({ compliancePath: dir, ctx: ctx(send()), api: okApi() })).rejects.toThrow(/services\/bistro-api is a symbolic link/);
      outsideIsUntouched(outside);
    });

    it('refuses a symlinked manifest.yaml', async () => {
      const { dir, outside } = withSymlinks((d, o) => {
        rmSync(join(d, 'services/bistro-api/manifest.yaml'));
        symlinkSync(join(o, 'target.txt'), join(d, 'services/bistro-api/manifest.yaml'));
      });
      await expect(run({ compliancePath: dir, ctx: ctx(send()), api: okApi() })).rejects.toThrow(/manifest\.yaml is a symbolic link/);
      outsideIsUntouched(outside);
    });

    it('lstat sanity: the fixture symlink really is one', () => {
      const d = tmp();
      mkdirSync(join(d, 'a'));
      symlinkSync(join(d, 'a'), join(d, 'b'));
      expect(lstatSync(join(d, 'b')).isSymbolicLink()).toBe(true);
    });
  });

  describe('git authentication', () => {
    it('passes the token through the environment, never through argv', async () => {
      const { dir } = complianceRepo();
      const calls: { args: string[]; env?: Record<string, string> }[] = [];
      const recording: GitRunner = (args, cwd, env) => {
        calls.push({ args, env });
        return runGit(args, cwd, env);
      };
      await run({ compliancePath: dir, ctx: ctx(send()), api: okApi(), git: recording });
      const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
      const argv = calls.map((c) => c.args.join(' ')).join('\n');
      expect(argv).not.toContain(TOKEN);
      expect(argv).not.toContain(basic);
      const push = calls.find((c) => c.args[0] === 'push')!;
      expect(push.env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
      expect(core.setSecret).toHaveBeenCalledWith(basic);
      expect(calls.filter((c) => c.env).map((c) => c.args[0]).sort()).toEqual(['fetch', 'ls-remote', 'push']);
    });
  });

  describe('compliance.yaml url', () => {
    for (const url of ['http://github.com/bistro-org/bistro-api', 'https://gitlab.com/bistro-org/bistro-api', 'https://github.com/bistro-org/bistro-api/tree/main', 'git@github.com:bistro-org/bistro-api.git']) {
      it(`fails closed on "${url}"`, async () => {
        const { dir } = complianceRepo();
        const f = join(dir, 'compliance.yaml');
        write(dir, 'compliance.yaml', rf(f, 'utf8').replace('https://github.com/bistro-org/bistro-api', url));
        await expect(run({ compliancePath: dir, ctx: ctx(send()), api: okApi() })).rejects.toThrow(/not https:\/\/github\.com|uri/);
      });
    }

    it('accepts a .git suffix', async () => {
      const { dir } = complianceRepo();
      const f = join(dir, 'compliance.yaml');
      write(dir, 'compliance.yaml', rf(f, 'utf8').replace('bistro-org/bistro-api\n', 'bistro-org/bistro-api.git\n'));
      await expect(run({ compliancePath: dir, ctx: ctx(send()), api: okApi() })).resolves.toBeUndefined();
    });
  });

  describe('human edits on the bot branch', () => {
    it('refuses to reset a branch whose open pull request has a commit by someone else', async () => {
      const { dir, remote } = complianceRepo();
      const api = okApi();
      await run({ compliancePath: dir, ctx: ctx(send()), api });
      const head = git(remote, 'rev-parse', 'refs/heads/compliance/bistro-api');
      api.findOpenPullRequest.mockResolvedValue({ number: 9, url: 'https://github.com/bistro-org/bistro-compliance/pull/9' });
      api.listPullRequestCommits.mockResolvedValue([
        { sha: 'f'.repeat(40), authorEmail: BOT_EMAIL },
        { sha: head, authorEmail: 'dpo@example.com' },
      ]);
      await expect(run({ compliancePath: dir, ctx: ctx(send({ sha: SHA2 })), api })).rejects.toThrow(/human edited the branch/);
      expect(git(remote, 'rev-parse', 'refs/heads/compliance/bistro-api')).toBe(head);
      expect(api.updatePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when the branch moved after the commits were read', async () => {
      const { dir } = complianceRepo();
      const api = okApi();
      await run({ compliancePath: dir, ctx: ctx(send()), api });
      api.findOpenPullRequest.mockResolvedValue({ number: 9, url: 'x' });
      api.listPullRequestCommits.mockResolvedValue([{ sha: 'e'.repeat(40), authorEmail: BOT_EMAIL }]);
      await expect(run({ compliancePath: dir, ctx: ctx(send({ sha: SHA2 })), api })).rejects.toThrow(/changed while/);
    });
  });

  it('logs values that come from the payload with core.notice, never core.info', async () => {
    const { dir } = complianceRepo();
    const api = okApi();
    const now = () => new Date('2026-04-01T10:00:00Z');
    await run({ compliancePath: dir, ctx: ctx(send()), api, now });
    git(dir, 'push', '-q', 'origin', 'HEAD:main'); // the pull request was merged
    await run({ compliancePath: dir, ctx: ctx(send()), api, now });
    expect(vi.mocked(core.notice).mock.calls.flat().join('\n')).toContain('services/bistro-api/');
    expect(vi.mocked(core.info).mock.calls.flat().join('\n')).not.toContain('services/bistro-api/');
  });
});
