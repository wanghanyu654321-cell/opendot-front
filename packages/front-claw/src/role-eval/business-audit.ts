import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AccessDecision } from './access-policy.js';
import type { PerformanceStore, Person } from './performance-store.js';
import type { EmployeeMessage } from './employee-loop.js';
import type { HandleResult } from './wecom-bot-unified-handler.js';

type Outcome = 'read' | 'written' | 'denied' | 'reply' | 'unknown';
interface MessageAudit {
  actor: { personId: string; role: Person['tier'] } | null;
  policyVersion: number | null;
  targetStoreId: string | null;
  targetDigest: string | null;
  readStoreIds: Set<string>;
  readOperations: Set<string>;
  attemptedWrites: Set<string>;
  writes: Set<string>;
  outcome: Outcome;
}
const active = new AsyncLocalStorage<MessageAudit>();
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function auditAuthorization(actor: Person, gate: AccessDecision) {
  const row = active.getStore();
  if (!row) return;
  row.actor = { personId: actor.personId, role: actor.tier };
  row.policyVersion = gate.version ?? null;
  if (!gate.allowed) row.outcome = 'denied';
}

export function auditTarget(target: string, resolved?: string) {
  const row = active.getStore();
  if (!row) return;
  row.targetStoreId = resolved ?? null;
  row.targetDigest = digest(target);
}

export function auditDecision(outcome: Outcome) {
  const row = active.getStore();
  if (row) row.outcome = outcome;
}

const filteredReads = new Set([
  'listEntries',
  'listDrafts',
  'listAppointments',
]);
const scopedReads = new Set([
  'getTarget',
  'listTargets',
  'getStoreTarget',
  'listStoreTargets',
  'listAliases',
]);
const rowReads = new Set([
  'getDraft',
  'getEntry',
  'getOpenDraft',
  'listRevisions',
]);
const writes = new Set([
  'saveDraft',
  'replacePendingReport',
  'transitionPendingDraft',
  'compareAndSetPendingAsk',
  'commitConfirmingDraft',
  'commitConfirmingAppointments',
  'commitConfirmingTarget',
  'commitConfirmingStoreTarget',
  'commitConfirmingCorrection',
]);

function changed(result: unknown): boolean {
  if (result === null || result === false) return false;
  if (typeof result === 'number') return result > 0;
  if (typeof result === 'string') return result === 'committed';
  if (result && typeof result === 'object') {
    if ('saved' in result) return result.saved === true;
    if ('outcome' in result) return result.outcome === 'committed';
  }
  return true;
}

/** Observe the existing store ports within one inbound async context. Persist only operation names and scope. */
export function createBusinessAudit(base: PerformanceStore) {
  const store = new Proxy(base, {
    get(target, key, receiver) {
      const fn: unknown = Reflect.get(target, key, receiver);
      if (typeof fn !== 'function') return fn;
      const name = String(key);
      return (...args: unknown[]) => {
        const row = active.getStore();
        if (!row) return Reflect.apply(fn, target, args);
        const businessWrite =
          writes.has(name) ||
          (name === 'setConfig' &&
            typeof args[0] === 'string' &&
            args[0].startsWith('employee-loop:'));
        if (businessWrite) {
          row.attemptedWrites.add(name);
          const entity = args[0];
          if (
            entity &&
            typeof entity === 'object' &&
            'storeId' in entity &&
            typeof entity.storeId === 'string'
          ) {
            auditTarget(entity.storeId, entity.storeId);
          }
        }
        const result: unknown = Reflect.apply(fn, target, args);
        if (rowReads.has(name)) {
          row.readOperations.add(name);
          return Promise.resolve(result).then((value) => {
            const records = Array.isArray(value) ? value : [value];
            for (const record of records) {
              if (record && typeof record.storeId === 'string')
                row.readStoreIds.add(record.storeId);
            }
            return value;
          });
        }
        if (filteredReads.has(name) || scopedReads.has(name)) {
          row.readOperations.add(name);
          const filter = args[0];
          const scope = scopedReads.has(name)
            ? filter
            : filter && typeof filter === 'object' && 'storeId' in filter
              ? filter.storeId
              : null;
          if (typeof scope === 'string') row.readStoreIds.add(scope);
        }
        if (businessWrite) {
          return Promise.resolve(result).then((value) => {
            if (changed(value)) row.writes.add(name);
            return value;
          });
        }
        return result;
      };
    },
  });
  async function run<T extends HandleResult>(
    input: EmployeeMessage,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!input.messageId) return work();
    const row: MessageAudit = {
      actor: null,
      policyVersion: null,
      targetStoreId: null,
      targetDigest: null,
      readStoreIds: new Set(),
      readOperations: new Set(),
      attemptedWrites: new Set(),
      writes: new Set(),
      outcome: 'reply',
    };
    const occurredAt = new Date().toISOString();
    const key =
      'business-audit:v1:' +
      digest(
        JSON.stringify([
          input.memberId,
          input.sessionId ?? null,
          input.bindingVersion ?? null,
          input.messageId,
        ]),
      );
    const requestFingerprint = digest(
      JSON.stringify([
        input.memberId,
        input.sessionId ?? null,
        input.bindingVersion ?? null,
        input.text,
      ]),
    );
    let duplicate = false;
    try {
      const result = await active.run(row, work);
      duplicate = 'duplicate' in result && result.duplicate === true;
      if ('state' in result && result.state !== 'completed')
        row.outcome = 'unknown';
      else if (row.outcome !== 'unknown' && row.writes.size)
        row.outcome = 'written';
      return result;
    } catch (error) {
      row.outcome = 'unknown';
      throw error;
    } finally {
      if (!duplicate) {
        const record = JSON.stringify({
          ...row,
          occurredAt,
          requestFingerprint,
          attemptedWrites: [...row.attemptedWrites],
          readStoreIds: [...row.readStoreIds],
          readOperations: [...row.readOperations],
          writes: [...row.writes],
        });
        try {
          await base.insertConfigIfAbsent(key, record);
        } catch {
          console.warn('front_claw_business_audit_unavailable', key);
        }
      }
    }
  }
  return { store, run };
}
