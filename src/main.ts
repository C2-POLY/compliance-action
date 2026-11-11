import * as core from '@actions/core';
import * as github from '@actions/github';
import { createApi } from './api.js';
import { runCheck } from './check.js';
import { ActionError } from './errors.js';
import { runReceive } from './receive.js';
import { runRegister } from './register.js';
import { runSend } from './send.js';
import type { EventContext } from './types.js';

function eventContext(): EventContext {
  const c = github.context;
  return { eventName: c.eventName, ref: c.ref, sha: c.sha, repo: c.repo, payload: c.payload };
}

function baseBranch(ctx: EventContext): string {
  const input = core.getInput('base-branch');
  const fallback = ctx.payload.repository?.default_branch;
  if (input) return input;
  if (typeof fallback === 'string' && fallback) return fallback;
  throw new ActionError('Cannot tell the default branch from the event: set the "base-branch" input.');
}

function secretToken(): string {
  const token = core.getInput('token', { required: true });
  core.setSecret(token);
  return token;
}

export async function run(): Promise<void> {
  const mode = core.getInput('mode', { required: true });
  const manifest = core.getInput('manifest') || '.compliance/manifest.yaml';
  switch (mode) {
    case 'check':
      runCheck(manifest);
      break;
    case 'send': {
      const token = secretToken();
      const ctx = eventContext();
      await runSend({
        manifestPath: manifest,
        complianceRepo: core.getInput('compliance-repo', { required: true }),
        baseBranch: baseBranch(ctx),
        ctx,
        api: createApi(token),
        cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      });
      break;
    }
    case 'receive': {
      const token = secretToken();
      const ctx = eventContext();
      await runReceive({
        compliancePath: core.getInput('compliance-path') || '.',
        baseBranch: baseBranch(ctx),
        manifestPath: manifest,
        token,
        verifySource: core.getInput('verify-source').toLowerCase() !== 'false',
        ctx,
        api: createApi(token),
      });
      break;
    }
    case 'register': {
      const token = secretToken();
      const ctx = eventContext();
      await runRegister({
        compliancePath: core.getInput('compliance-path') || '.',
        baseBranch: baseBranch(ctx),
        token,
        generatedAt: core.getInput('generated-at') || undefined,
        ctx,
        api: createApi(token),
      });
      break;
    }
    default:
      throw new ActionError(`Unknown mode "${mode}". Use check, send, receive or register.`);
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof ActionError ? err.message : err instanceof Error ? err.message : String(err));
});
