import * as github from '@actions/github';
import type { RepoRef } from './types.js';

export interface PullRequest {
  number: number;
  url: string;
}

/** The GitHub calls the action makes. Small on purpose, so that tests can replace it. */
export interface Api {
  /** Content of a file on the default branch of a repo, or null if the file does not exist. */
  getFile(repo: RepoRef, path: string, ref?: string): Promise<string | null>;
  /** Whether `sha` is on the default branch of a repo (the branch head or one of its ancestors). */
  isOnDefaultBranch(repo: RepoRef, sha: string): Promise<boolean>;
  /** Commits of a pull request, oldest first. */
  listPullRequestCommits(repo: RepoRef, number: number): Promise<{ sha: string; authorEmail: string | null }[]>;
  dispatch(repo: RepoRef, eventType: string, payload: Record<string, unknown>): Promise<void>;
  findOpenPullRequest(repo: RepoRef, head: string, base: string): Promise<PullRequest | null>;
  createPullRequest(repo: RepoRef, args: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  updatePullRequest(repo: RepoRef, number: number, args: { title: string; body: string }): Promise<PullRequest>;
}

export function createApi(token: string): Api {
  const octokit = github.getOctokit(token);
  const pr = (d: { number: number; html_url: string }): PullRequest => ({ number: d.number, url: d.html_url });
  return {
    async getFile(repo, path, ref) {
      try {
        const { data } = await octokit.rest.repos.getContent({ ...repo, path, ...(ref ? { ref } : {}) });
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
        return Buffer.from(data.content, 'base64').toString('utf8');
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },
    async isOnDefaultBranch(repo, sha) {
      const { data: info } = await octokit.rest.repos.get({ ...repo });
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${info.default_branch}...${sha}` });
      return data.status === 'behind' || data.status === 'identical';
    },
    async listPullRequestCommits(repo, number) {
      const commits = await octokit.paginate(octokit.rest.pulls.listCommits, { ...repo, pull_number: number, per_page: 100 });
      return commits.map((c) => ({ sha: c.sha, authorEmail: c.commit.author?.email ?? null }));
    },
    async dispatch(repo, eventType, payload) {
      await octokit.rest.repos.createDispatchEvent({
        ...repo,
        event_type: eventType,
        client_payload: payload,
      });
    },
    async findOpenPullRequest(repo, head, base) {
      const { data } = await octokit.rest.pulls.list({ ...repo, state: 'open', head: `${repo.owner}:${head}`, base });
      return data[0] ? pr(data[0]) : null;
    },
    async createPullRequest(repo, args) {
      const { data } = await octokit.rest.pulls.create({ ...repo, ...args });
      return pr(data);
    },
    async updatePullRequest(repo, number, args) {
      const { data } = await octokit.rest.pulls.update({ ...repo, pull_number: number, ...args });
      return pr(data);
    },
  };
}

/** Turns an Octokit error into a message that never carries the token. */
export function explainGitHubError(err: unknown, what: string): string {
  const status = (err as { status?: number }).status;
  switch (status) {
    case 401:
      return `${what}: the token is invalid or expired (HTTP 401).`;
    case 403:
      return `${what}: the token has no permission for this (HTTP 403). It needs Contents: read and write and Pull requests: write on the compliance repo, and the compliance repo must allow it.`;
    case 404:
      return `${what}: compliance repo not found, or the token has no access to it (HTTP 404).`;
    default:
      return `${what}: GitHub request failed${status ? ` (HTTP ${status})` : ''}.`;
  }
}
