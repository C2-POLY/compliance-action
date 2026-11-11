import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { computeLag } from '../src/lag.js';
import { commit, git, initRepo, mockApi } from './helpers.js';

vi.mock('@actions/core');
beforeEach(() => vi.clearAllMocks());

const complianceRepo = { owner: 'bistro-org', repo: 'bistro-compliance' };
const anchors = (sha: string) =>
  `spec_version: "0.1"\ngenerated_at: "2026-03-11T08:00:00Z"\nrepos:\n  bistro-api:\n    sha: ${sha}\n`;

function setup() {
  const cwd = initRepo();
  const anchor = commit(cwd, 'src/bookings/guest.ts', 'v1');
  commit(cwd, 'README.md', 'readme');
  return { cwd, anchor };
}
const lag = (cwd: string, anchorsText: string | null, linkedFiles: string[] = ['src/bookings/**']) =>
  computeLag({
    api: mockApi({ getFile: vi.fn(async () => anchorsText) }),
    complianceRepo,
    repoName: 'bistro-api',
    sha: git(cwd, 'rev-parse', 'HEAD'),
    linkedFiles,
    cwd,
  });

describe('lag', () => {
  it('counts only commits that touch linked files (in-sync when none)', async () => {
    const { cwd, anchor } = setup();
    commit(cwd, 'docs/notes.md', 'unlinked');
    expect(await lag(cwd, anchors(anchor))).toEqual({ anchor, count: 0, commits: [] });
  });

  it('increments with each linked commit, newest first', async () => {
    const { cwd, anchor } = setup();
    const c1 = commit(cwd, 'src/bookings/guest.ts', 'v2');
    commit(cwd, 'docs/notes.md', 'unlinked');
    const c2 = commit(cwd, 'src/bookings/deep/new.ts', 'x');
    expect(await lag(cwd, anchors(anchor))).toEqual({ anchor, count: 2, commits: [c2, c1] });
  });

  it('reads the anchor of the right repo name', async () => {
    const { cwd, anchor } = setup();
    commit(cwd, 'src/bookings/guest.ts', 'v2');
    const text = anchors(anchor);
    const result = await computeLag({
      api: mockApi({ getFile: vi.fn(async () => text) }),
      complianceRepo,
      repoName: 'bistro-web',
      sha: git(cwd, 'rev-parse', 'HEAD'),
      linkedFiles: ['src/bookings/**'],
      cwd,
    });
    expect(result).toEqual({ anchor: null, count: 0, commits: [] });
  });

  it('is "never documented" without anchors.yaml', async () => {
    const { cwd } = setup();
    expect(await lag(cwd, null)).toEqual({ anchor: null, count: 0, commits: [] });
  });

  it('is "never documented" when the repo has no entry', async () => {
    const { cwd } = setup();
    const text = 'spec_version: "0.1"\ngenerated_at: "2026-03-11T08:00:00Z"\nrepos: {}\n';
    expect(await lag(cwd, text)).toEqual({ anchor: null, count: 0, commits: [] });
  });

  it('is unknown, with a fetch-depth warning, when the anchor is not in the history', async () => {
    const { cwd } = setup();
    const result = await lag(cwd, anchors('4b8d2f6a0c1e9375a2d4f6b8c0e2a4d6f8b1c3e5'));
    expect(result).toMatchObject({ status: 'unknown' });
    expect(vi.mocked(core.warning).mock.calls.flat().join('\n')).toContain('fetch-depth: 0');
  });

  it('is unknown when the manifest has no linked_files', async () => {
    const { cwd, anchor } = setup();
    expect(await lag(cwd, anchors(anchor), [])).toMatchObject({ status: 'unknown' });
  });

  it('is unknown when anchors.yaml is invalid', async () => {
    const { cwd } = setup();
    expect(await lag(cwd, 'repos: 3\n')).toMatchObject({ status: 'unknown' });
    expect(core.warning).toHaveBeenCalled();
  });

  it('is unknown when the anchor is not an ancestor (history rewritten)', async () => {
    const { cwd, anchor } = setup();
    git(cwd, 'checkout', '-q', '-b', 'other', 'HEAD~1');
    commit(cwd, 'src/bookings/guest.ts', 'diverged');
    expect(await lag(cwd, anchors(git(cwd, 'rev-parse', 'main')))).toMatchObject({ status: 'unknown' });
    expect(anchor).toBeTruthy();
  });
});
