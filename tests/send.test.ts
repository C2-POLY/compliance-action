import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { MAX_MANIFEST_BYTES, runSend } from '../src/send.js';
import type { EventContext } from '../src/types.js';
import { FIXTURES, initRepo, logged, mockApi, tmp, write } from './helpers.js';

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const SHA = '7c1e4f9a2b6d8035e1a4c7f90b2d6e8a1c3f5b79';
const TOKEN = 'ghp_SECRET_TOKEN_0123456789';
const manifestPath = join(FIXTURES, 'manifests', 'valid.yaml');
const ctx = (over: Partial<EventContext> = {}): EventContext => ({
  eventName: 'push',
  ref: 'refs/heads/main',
  sha: SHA,
  repo: { owner: 'bistro-org', repo: 'bistro-api' },
  payload: {},
  ...over,
});
const base = (api = mockApi(), c = ctx()) => ({
  manifestPath,
  complianceRepo: 'bistro-org/bistro-compliance',
  baseBranch: 'main',
  ctx: c,
  api,
  cwd: initRepo(),
});

describe('mode send', () => {
  it('skips on a push to another branch', async () => {
    const api = mockApi();
    await runSend(base(api, ctx({ ref: 'refs/heads/feature/x' })));
    expect(api.dispatch).not.toHaveBeenCalled();
    expect(vi.mocked(core.info).mock.calls.flat().join('\n')).toContain('Skipped');
  });

  it('skips on a pull_request event', async () => {
    const api = mockApi();
    await runSend(base(api, ctx({ eventName: 'pull_request', ref: 'refs/pull/3/merge' })));
    expect(api.dispatch).not.toHaveBeenCalled();
  });

  it('sends repository_dispatch with repo, sha, manifest text and lag', async () => {
    const api = mockApi();
    await runSend(base(api));
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    const [repo, type, payload] = api.dispatch.mock.calls[0];
    expect(repo).toEqual({ owner: 'bistro-org', repo: 'bistro-compliance' });
    expect(type).toBe('compliance-manifest');
    expect(payload).toEqual({
      repo: 'bistro-org/bistro-api',
      sha: SHA,
      manifest: readFileSync(manifestPath, 'utf8'),
      lag: { anchor: null, count: 0, commits: [] },
    });
    expect(Object.keys(payload).length).toBeLessThanOrEqual(10);
    expect(core.setOutput).toHaveBeenCalledWith('lag-count', 0);
    expect(core.setOutput).toHaveBeenCalledWith('lag-status', 'never-documented');
  });

  it('does not send an invalid manifest', async () => {
    const api = mockApi();
    const o = { ...base(api), manifestPath: join(FIXTURES, 'manifests', 'invalid-bad-category.yaml') };
    await expect(runSend(o)).rejects.toThrow(/not a valid manifest/);
    expect(api.dispatch).not.toHaveBeenCalled();
  });

  it('fails clearly when the manifest is over the payload budget', async () => {
    const dir = tmp();
    const text = readFileSync(manifestPath, 'utf8') + `\n# ${'x'.repeat(MAX_MANIFEST_BYTES)}\n`;
    write(dir, 'm.yaml', text);
    const api = mockApi();
    await expect(runSend({ ...base(api), manifestPath: join(dir, 'm.yaml') })).rejects.toThrow(/over the 61440 bytes/);
    expect(api.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a malformed compliance-repo', async () => {
    await expect(runSend({ ...base(), complianceRepo: 'nope' })).rejects.toThrow(/owner\/name/);
  });

  for (const [status, text] of [
    [401, /token is invalid/],
    [403, /no permission/],
    [404, /not found, or the token has no access/],
  ] as const) {
    it(`maps HTTP ${status} to a clear message without the token`, async () => {
      const api = mockApi({
        dispatch: vi.fn(async () => {
          throw Object.assign(new Error(`Bad credentials ${TOKEN}`), { status });
        }),
      });
      const err = await runSend(base(api)).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(text);
      expect((err as Error).message).not.toContain(TOKEN);
      expect(logged().join('\n')).not.toContain(TOKEN);
    });
  }

  it('never logs the token on the happy path', async () => {
    // The token is only ever handed to the API factory and setSecret (see main.ts); the logic never sees it.
    const api = mockApi();
    await runSend(base(api));
    expect(logged().join('\n')).not.toContain(TOKEN);
  });

  it('never fails because the lag could not be computed: it reports "lag unknown"', async () => {
    const api = mockApi({
      getFile: vi.fn(async () => {
        throw Object.assign(new Error(`boom ${TOKEN}`), { status: 403 });
      }),
    });
    await runSend(base(api));
    expect(api.dispatch).toHaveBeenCalledTimes(1);
    expect(api.dispatch.mock.calls[0][2]).toMatchObject({ lag: { status: 'unknown' } });
    expect(api.dispatch.mock.calls[0][2].lag).toEqual({ status: 'unknown' }); // no reason in the payload
    const text = logged().join('\n');
    expect(text).toContain('lag unknown: anchors.yaml could not be read (HTTP 403)');
    expect(text).not.toContain('GitHub request failed');
    expect(text).not.toContain(TOKEN);
    expect(core.setOutput).toHaveBeenCalledWith('lag-status', 'unknown');
  });
});
