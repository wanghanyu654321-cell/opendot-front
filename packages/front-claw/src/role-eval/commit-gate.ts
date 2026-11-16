import { sameBinding, type WecomBotBinding } from './wecom-bot-bindings.js';
import { ACCESS_POLICY_KEY, decideAccess, parseAccessPolicy, policyFrom, POLICY_LOCK_KEYS, standing, type Capability } from './access-policy.js';
import { fenceHolds, parseLeaseRecord, type Fence } from './fencing.js';
import type { CommitGuard, GateSnapshot, PerformanceStore, Person } from './performance-store.js';

/**
 * R1 出口 (a)：入账门。所有业务提交（报数/目标/更正/预约）在同一事务里按最新数据统一复核；
 * 事务外的同一判定用于旧草稿重放、请求缓存命中、查询/营销结果发出前。
 *
 * 复核项（任何一项不过即拒绝）：
 * 1. 策略：版本 ≥ 高水位（单调版本，防旧原文回写）、当前角色与授权、能力/门店（策略模式）；
 * 2. 提交人：当前人员行在职、档案完整，accountId/memberId/门店/tier 与发起时一致；
 * 3. 被代报人/目标对象：当前人员行在职、档案完整、与草稿同店、姓名未变（业绩归括号员工，跨店拒绝）；
 * 4. fencing（M07）：消费租约当前 owner+epoch 与本请求领取时一致且未到期。
 */
export interface GateTarget { personId: string; displayName: string; storeId: string }
export interface GateSpec {
  actor: Person;
  binding?: Readonly<WecomBotBinding> | undefined;
  validate?: (() => Promise<boolean>) | undefined;
  active?: (() => boolean) | undefined;
  /** 本次操作需要的能力与门店；capability=null 表示只要求有效身份（standing）。 */
  capability: Capability | null;
  storeIds: readonly string[];
  targets?: readonly GateTarget[];
  /** 额外需要锁读并复核的人员（如预约指定店长），只锁不判；判定由调用方 noticeAllowed 用快照完成。 */
  observe?: readonly string[];
  policyMode: boolean;
  platform?: readonly Capability[] | undefined;
  fence?: Fence | undefined;
  nowMs: () => number;
  /**
   * R2：确认预检时读到的策略版本。提交事务内的最新版本必须与之相等——预检之后任何策略变更（撤权、提升版本）
   * 都让本次提交失败、草稿退回待确认，由本人重新确认（不在旧判断上落账）。undefined = 不钉版本（事务外复核）。
   */
  policyVersion?: number | undefined;
}
export type GateResult = { ok: true } | { ok: false; reason: 'policy' | 'policy_changed' | 'actor_changed' | 'target_invalid' | 'fenced' | 'binding_changed' };
/** R2：策略原文里的版本号（缺失/损坏为 null）。 */
export function policyVersionOf(raw: string | null): number | null {
  const parsed = parseAccessPolicy(raw);
  return parsed && parsed !== 'missing' ? parsed.version : null;
}

const valid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512;
const complete = (person: Person | null | undefined): person is Person => !!person?.active &&
  [person.personId, person.accountId, person.memberId, person.displayName, person.storeId, person.storeName].every(valid);

export const gateKeys = (spec: GateSpec): string[] => [...(spec.policyMode ? POLICY_LOCK_KEYS : []), ...(spec.fence ? [spec.fence.key] : [])];
export const gatePeople = (spec: GateSpec): string[] =>
  [...new Set([spec.actor.personId, ...(spec.targets ?? []).map(t => t.personId), ...(spec.observe ?? [])])].sort();

export function evaluateGate(spec: GateSpec, snapshot: GateSnapshot): GateResult {
  if (spec.active && !spec.active() || spec.binding && !sameBinding(spec.binding, snapshot.binding)) return { ok: false, reason: 'binding_changed' };
  if (spec.fence && !fenceHolds(parseLeaseRecord(snapshot.config[spec.fence.key] ?? null), spec.fence, spec.nowMs())) return { ok: false, reason: 'fenced' };
  const current = snapshot.people[spec.actor.personId] ?? null;
  const a = spec.actor;
  if (!complete(current) || current.accountId !== a.accountId || current.memberId !== a.memberId || current.storeId !== a.storeId || current.tier !== a.tier) {
    return { ok: false, reason: 'actor_changed' };
  }
  for (const target of spec.targets ?? []) {
    const person = snapshot.people[target.personId] ?? null;
    if (!complete(person) || person.storeId !== target.storeId || person.displayName !== target.displayName) return { ok: false, reason: 'target_invalid' };
  }
  if (spec.policyMode) {
    const policy = policyFrom(snapshot.config);
    if (spec.capability === null) { if (!standing(policy, current).allowed) return { ok: false, reason: 'policy' }; }
    else if (!spec.storeIds.length || !spec.storeIds.every(storeId => decideAccess(policy, current, spec.capability!, storeId, spec.platform).allowed)) return { ok: false, reason: 'policy' };
    // R2：新策略仍允许，但版本已不是预检时那一版 → 也不在旧判断上落账。
    if (spec.policyVersion !== undefined && policyVersionOf(snapshot.config[ACCESS_POLICY_KEY] ?? null) !== spec.policyVersion) return { ok: false, reason: 'policy_changed' };
  }
  return { ok: true };
}

/** 事务内使用：stores 在同一事务里 FOR SHARE 读 keys 与 personIds，再调用 checkSnapshot。 */
export function commitGuard(spec: GateSpec, onDeny?: (reason: Exclude<GateResult, { ok: true }>['reason']) => void): CommitGuard {
  const keys = gateKeys(spec);
  return {
    ...(spec.binding ? { binding: Object.freeze(structuredClone(spec.binding)) } : {}),
    ...(spec.validate ? { validate: spec.validate } : {}),
    ...(spec.active ? { active: spec.active } : {}),
    key: keys[0] ?? '',
    extraKeys: keys.slice(1),
    personIds: gatePeople(spec),
    check: () => false, // 只给不懂快照的旧 store 用：不认识快照即拒绝（失败关闭）
    checkSnapshot: snapshot => { const result = evaluateGate(spec, snapshot); if (!result.ok) onDeny?.(result.reason); return result.ok; },
    ...(spec.fence ? { fence: { key: spec.fence.key, owner: spec.fence.owner, epoch: spec.fence.epoch, nowMs: spec.nowMs } } : {}),
  };
}

/** 事务外使用：读当前数据后同一判定。 */
export async function checkGateNow(store: Pick<PerformanceStore, 'getConfig' | 'getPerson'>, spec: GateSpec): Promise<GateResult> {
  if (spec.validate && !await spec.validate()) return { ok: false, reason: 'binding_changed' };
  const config: Record<string, string | null> = {};
  for (const key of gateKeys(spec)) config[key] = await store.getConfig(key);
  const people: Record<string, Person | null> = {};
  for (const id of gatePeople(spec)) people[id] = await store.getPerson(id);
  return evaluateGate(spec, { config, people, ...(spec.binding ? { binding: structuredClone(spec.binding) } : {}) });
}
