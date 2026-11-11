import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';

vi.mock('@actions/core');
vi.mock('@actions/github', () => ({
  context: { eventName: 'push', ref: 'refs/heads/main', sha: 'a'.repeat(40), repo: { owner: 'o', repo: 'r' }, payload: {} },
  getOctokit: vi.fn(),
}));

const TOKEN = 'ghp_SECRET_TOKEN_0123456789';
const inputs = (values: Record<string, string>) =>
  vi.mocked(core.getInput).mockImplementation((name: string) => values[name] ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('main', () => {
  it('masks the token before anything else in send mode', async () => {
    inputs({ mode: 'send', token: TOKEN, 'compliance-repo': 'nope', 'base-branch': 'main', manifest: 'tests/fixtures/manifests/valid.yaml' });
    await import('../src/main.js');
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalled());
    expect(core.setSecret).toHaveBeenCalledWith(TOKEN);
    const failures = JSON.stringify(vi.mocked(core.setFailed).mock.calls);
    expect(failures).not.toContain(TOKEN);
  });

  it('rejects mode register as not implemented', async () => {
    inputs({ mode: 'register' });
    await import('../src/main.js');
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledWith('mode "register" is not implemented yet.'));
  });

  it('rejects an unknown mode', async () => {
    inputs({ mode: 'bogus' });
    await import('../src/main.js');
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Unknown mode')));
  });
});
