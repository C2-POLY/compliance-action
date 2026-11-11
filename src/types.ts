export interface RepoRef {
  owner: string;
  repo: string;
}

/** The part of the GitHub event the action needs. */
export interface EventContext {
  eventName: string;
  ref: string;
  sha: string;
  repo: RepoRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}

export type Lag =
  | { anchor: string | null; count: number; commits: string[] }
  | { status: 'unknown' };

/** A lag with the reason it is unknown, for logs only (the reason is not part of the format). */
export type LagResult = Lag & { reason?: string };

export type LagStatus = 'in-sync' | 'behind' | 'never-documented' | 'unknown';

export function lagStatus(lag: Lag): LagStatus {
  if ('status' in lag) return 'unknown';
  if (lag.anchor === null) return 'never-documented';
  return lag.count > 0 ? 'behind' : 'in-sync';
}

export function lagCount(lag: Lag): number {
  return 'status' in lag ? 0 : lag.count;
}
