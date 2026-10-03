import { randomUUID } from 'node:crypto';

/** Prefixed identifiers make logs and database rows self-describing. */
export const IdPrefix = {
  task: 'tsk',
  job: 'job',
  event: 'evt',
  decision: 'dec',
  memory: 'mem',
  agentRun: 'arun',
  modelRun: 'mrun',
  correlation: 'cor',
  evaluation: 'evl',
  identityVersion: 'idv',
  strategyVersion: 'stv',
  visualIdentityVersion: 'viv',
  production: 'prd',
  artifact: 'art',
  asset: 'ast',
  credential: 'crd',
  checkpoint: 'ckp',
} as const;

export type IdKind = keyof typeof IdPrefix;

export function newId(kind: IdKind): string {
  return `${IdPrefix[kind]}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
