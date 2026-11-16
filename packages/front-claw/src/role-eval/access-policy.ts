import type { PerformanceStore, Person, Tier } from './performance-store.js';

/**
 * M03 访问策略：服务端唯一授权来源（PG config 键，JSON，无 schema 变更）。
 * 有效能力 = 已实现 ∩ 企业层 ∩ 门店层 ∩ 角色层 ∩ 成员收窄（若列出）∩ 平台层（若传入），拒绝优先：
 * - 显式空列表就是空；缺层、缺门店、缺成员即拒绝，不回退默认；
 * - JSON 损坏、未知字段、未知能力、类型不符 → 整份策略视为损坏，一律拒绝；
 * - 角色只来自成员授权且必须与 people.tier 一致；不从聊天正文、岗位角色或临时名单推导；
 * - 老板门店集合必须显式列出（空=无门店，不是全部）；员工/店长只能是本人所在店。
 * 每次鉴权都重新读库，不缓存。
 */
export const ACCESS_POLICY_KEY = 'front-claw-access';
/** 已用过的最高版本；与策略同事务写入，防止旧配置回写复活已撤权身份。 */
export const ACCESS_POLICY_HIGH_WATER_KEY = 'front-claw-access:high-water';
export const ACCESS_AUDIT_PREFIX = 'front-claw-access:audit:';
export const CAPABILITIES = ['report_self', 'report_proxy', 'progress_self', 'progress_other', 'store_summary', 'unreported', 'stores_ranking', 'marketing',
  /** M04：目标设置（先草稿后确认）、本人当日更正、门店范围更正。 */
  'target_set', 'correct_own', 'correct_store',
  /** M05：登记预约（登记即成立）；作为指定店长接收预约提醒、查本店预约。 */
  'appointment_submit', 'appointment_receive'] as const;
export type Capability = typeof CAPABILITIES[number];
/** 本仓库已实现的能力；配置不能授予未实现的能力。 */
export const IMPLEMENTED_CAPABILITIES: readonly Capability[] = CAPABILITIES;
const TIERS: readonly Tier[] = ['employee', 'manager', 'owner'];
const STATUSES = ['active', 'suspended', 'revoked'] as const;

export interface MemberGrant { role: Tier; storeIds: string[]; status: typeof STATUSES[number]; capabilities?: Capability[]; }
export interface AccessPolicy {
  version: number;
  enterprise: Capability[];
  stores: Record<string, Capability[]>;
  roles: Record<Tier, Capability[]>;
  members: Record<string, MemberGrant>;
}
export type DenyReason = 'no_policy' | 'broken_policy' | 'stale_policy' | 'no_grant' | 'inactive' | 'role_mismatch' | 'store_out_of_scope' | 'capability_denied' | 'person_invalid';
export type AccessDecision = { allowed: true; version: number; role: Tier } | { allowed: false; reason: DenyReason; version?: number };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 120 && !/[\u0000-\u001f]/.test(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function capList(value: unknown): Capability[] | null {
  if (!Array.isArray(value) || value.length > CAPABILITIES.length * 2) return null;
  if (!value.every(item => typeof item === 'string' && (CAPABILITIES as readonly string[]).includes(item))) return null;
  return [...new Set(value as Capability[])];
}

/** 严格解析；任何不合规都返回 null（=损坏）。 */
export function parseAccessPolicy(raw: string | null): AccessPolicy | null | 'missing' {
  if (raw === null) return 'missing';
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || !exactKeys(value, ['version', 'enterprise', 'stores', 'roles', 'members'])) return null;
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) return null;
  const enterprise = capList(value.enterprise);
  if (!enterprise || !isRecord(value.stores) || !isRecord(value.roles) || !isRecord(value.members)) return null;
  const stores: Record<string, Capability[]> = {};
  for (const [storeId, caps] of Object.entries(value.stores)) { const list = capList(caps); if (!id(storeId) || !list) return null; stores[storeId] = list; }
  if (!exactKeys(value.roles, TIERS)) return null;
  const roles = {} as Record<Tier, Capability[]>;
  for (const tier of TIERS) { const list = capList(value.roles[tier]); if (!list) return null; roles[tier] = list; }
  const members: Record<string, MemberGrant> = {};
  for (const [personId, grant] of Object.entries(value.members)) {
    if (!id(personId) || !isRecord(grant) || !exactKeys(grant, ['role', 'storeIds', 'status'], ['capabilities'])) return null;
    if (!TIERS.includes(grant.role as Tier) || !(STATUSES as readonly unknown[]).includes(grant.status)) return null;
    if (!Array.isArray(grant.storeIds) || !grant.storeIds.every(id) || new Set(grant.storeIds).size !== grant.storeIds.length) return null;
    const narrowed = grant.capabilities === undefined ? undefined : capList(grant.capabilities);
    if (narrowed === null) return null;
    members[personId] = { role: grant.role as Tier, storeIds: [...grant.storeIds as string[]], status: grant.status as MemberGrant['status'], ...(narrowed ? { capabilities: narrowed } : {}) };
  }
  return { version: value.version as number, enterprise, stores, roles, members };
}

/**
 * R1：策略输入 = 策略原文 + 高水位原文（同一事务/同一次读取）。纯字符串只用于解析类单测，
 * 服务端所有判定都传对象，从而同时检查“版本单调”：策略版本 < 高水位（旧原文被回写）、高水位缺失或损坏 → 拒绝。
 */
export type PolicyInput = string | null | { policy: string | null; highWater: string | null };
function resolvePolicy(input: PolicyInput): AccessPolicy | 'missing' | 'broken' | 'stale' {
  const raw = input !== null && typeof input === 'object' ? input.policy : input;
  const policy = parseAccessPolicy(raw);
  if (policy === 'missing') return 'missing';
  if (!policy) return 'broken';
  if (input !== null && typeof input === 'object') {
    const hw = input.highWater;
    if (hw === null || !/^(?:0|[1-9]\d{0,15})$/.test(hw) || !Number.isSafeInteger(Number(hw))) return 'stale';
    if (policy.version < Number(hw)) return 'stale';
  }
  return policy;
}
/** 读当前策略与高水位（不缓存）。 */
export async function readPolicy(store: Pick<PerformanceStore, 'getConfig'>): Promise<{ policy: string | null; highWater: string | null }> {
  // R2：事务外两次读不是同一快照。先读高水位、后读策略：策略与高水位在同一事务里一起提升，所以后读到的策略版本 ≥ 先读到的高水位，
  // 并发改策略时不会误判“策略落后于高水位”（R1 顺序相反，改策略恰好落在两次读之间会误拒，盲测 PG 竞态复跑时偶发）。
  const highWater = await store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY);
  return { policy: await store.getConfig(ACCESS_POLICY_KEY), highWater };
}
/** 从锁读得到的配置表里取策略输入。 */
export const policyFrom = (config: Record<string, string | null>) => ({ policy: config[ACCESS_POLICY_KEY] ?? null, highWater: config[ACCESS_POLICY_HIGH_WATER_KEY] ?? null });
export const POLICY_LOCK_KEYS = [ACCESS_POLICY_HIGH_WATER_KEY, ACCESS_POLICY_KEY] as const;

/** 纯函数判定：给定策略输入、当前人员档案、能力和目标门店。 */
/**
 * R2（D5-roles-draft 已定规则 → 档位上限，策略只能在此之内收窄）：
 * 员工：查业绩只能查自己（无 progress_other/store_summary/unreported/stores_ranking）；设月目标不能（无 target_set）；修改只能改自己的（无 correct_store）。
 * 店长：可改本店的单（correct_store）。老板：不能报单（report_self/report_proxy）。营销默认关，按企微 ID 在成员 capabilities 里开通。
 */
/** R5（D105/D5）：营销是按人开通的选配能力，默认关，须在成员 capabilities 里显式列出。 */
export const OPT_IN_CAPABILITIES: readonly Capability[] = Object.freeze(['marketing'] as Capability[]);
export const TIER_FORBIDDEN: Readonly<Record<Tier, readonly Capability[]>> = Object.freeze({
  employee: Object.freeze(['progress_other', 'store_summary', 'unreported', 'stores_ranking', 'target_set', 'correct_store'] as Capability[]),
  manager: Object.freeze([] as Capability[]),
  /** R5：老板不能报单（含代报）。 */
  owner: Object.freeze(['report_self', 'report_proxy'] as Capability[]),
});

/** R5：按企微 ID（people.memberId）给某人开通选配能力。成员 capabilities 在原有收窄列表上追加（不删已有项）。 */
export function enableOptInForMember(policy: AccessPolicy, personId: string, capability: Capability): AccessPolicy {
  const grant = policy.members[personId];
  if (!grant) return policy;
  const caps = [...new Set([...(grant.capabilities ?? []), capability])];
  return { ...policy, members: { ...policy.members, [personId]: { ...grant, capabilities: caps } } };
}
/** 按企微成员 ID（people.memberId）查找 personId 后开通选配能力。找不到人则原样返回。 */
export function enableOptInByMemberId(policy: AccessPolicy, people: readonly Person[], memberId: string, capability: Capability): AccessPolicy {
  const person = people.find(p => p.memberId === memberId);
  return person ? enableOptInForMember(policy, person.personId, capability) : policy;
}
export function decideAccess(raw: PolicyInput, person: Person | null, capability: Capability, storeId: string, platform?: readonly Capability[]): AccessDecision {
  const policy = resolvePolicy(raw);
  if (policy === 'missing') return { allowed: false, reason: 'no_policy' };
  if (policy === 'broken') return { allowed: false, reason: 'broken_policy' };
  if (policy === 'stale') return { allowed: false, reason: 'stale_policy' };
  const version = policy.version;
  if (!person || !id(person.personId) || !id(person.storeId) || !TIERS.includes(person.tier)) return { allowed: false, reason: 'person_invalid', version };
  const grant = policy.members[person.personId];
  if (!grant) return { allowed: false, reason: 'no_grant', version };
  if (grant.status !== 'active' || !person.active) return { allowed: false, reason: 'inactive', version };
  if (grant.role !== person.tier) return { allowed: false, reason: 'role_mismatch', version };
  if (!grant.storeIds.length) return { allowed: false, reason: 'store_out_of_scope', version };
  if (grant.role !== 'owner' && (grant.storeIds.length !== 1 || grant.storeIds[0] !== person.storeId)) return { allowed: false, reason: 'store_out_of_scope', version };
  if (!grant.storeIds.includes(storeId)) return { allowed: false, reason: 'store_out_of_scope', version };
  // R2/R5（D5 已定档）：档位上限层——策略再怎么配，员工也拿不到他人/全店查询、设目标、改他人账；老板不能报单。
  if (TIER_FORBIDDEN[grant.role].includes(capability)) return { allowed: false, reason: 'capability_denied', version };
  const optIn = (OPT_IN_CAPABILITIES as readonly string[]).includes(capability);
  // 选配：capabilities 未定义 → 常规不收窄、选配关；[] → 全部拒绝；
  // 只有选配项（如 ['marketing']）→ 常规不收窄，选配按列出的开通；
  // 含常规项 → 常规按列出的收窄，选配仍须显式列出。
  const personDefined = grant.capabilities !== undefined;
  const regularListed = (grant.capabilities ?? []).filter(cap => !(OPT_IN_CAPABILITIES as readonly string[]).includes(cap));
  const onlyOptIn = personDefined && regularListed.length === 0 && grant.capabilities!.length > 0;
  const personRegular = !personDefined || onlyOptIn ? undefined : regularListed;
  const personOptIn = grant.capabilities; // 选配：必须显式出现；undefined / 空都不算开通
  const upper: (readonly Capability[] | undefined)[] = [IMPLEMENTED_CAPABILITIES, policy.enterprise, policy.stores[storeId] ?? [], policy.roles[grant.role], platform];
  const upperOk = upper.every(layer => layer === undefined || layer.includes(capability));
  const personOk = optIn
    ? !!personOptIn && personOptIn.includes(capability) // 选配：人这一层必须显式列出；undefined/空即关
    : personRegular === undefined || personRegular.includes(capability);
  const allowed = upperOk && personOk;
  return allowed ? { allowed: true, version, role: grant.role } : { allowed: false, reason: 'capability_denied', version };
}

/** 入口判定：策略可用且本人有有效授权（不看具体能力）。 */
export function standing(raw: PolicyInput, person: Person | null): AccessDecision {
  const policy = resolvePolicy(raw);
  if (policy === 'missing') return { allowed: false, reason: 'no_policy' };
  if (policy === 'broken') return { allowed: false, reason: 'broken_policy' };
  if (policy === 'stale') return { allowed: false, reason: 'stale_policy' };
  const grant = person ? policy.members[person.personId] : undefined;
  if (!person || !grant) return { allowed: false, reason: 'no_grant', version: policy.version };
  if (grant.status !== 'active' || !person.active) return { allowed: false, reason: 'inactive', version: policy.version };
  if (grant.role !== person.tier) return { allowed: false, reason: 'role_mismatch', version: policy.version };
  return { allowed: true, version: policy.version, role: grant.role };
}
/** 读当前策略（不缓存）后判定。 */
export async function authorize(store: PerformanceStore, person: Person | null, capability: Capability, storeId: string, platform?: readonly Capability[]): Promise<AccessDecision> {
  return decideAccess(await readPolicy(store), person, capability, storeId, platform);
}
/** 列出某人在当前策略下可用某能力的全部门店（显式集合内逐个判定）。 */
export async function authorizedStores(store: PerformanceStore, person: Person, capability: Capability, platform?: readonly Capability[]): Promise<string[]> {
  const raw = await readPolicy(store);
  const policy = resolvePolicy(raw);
  if (typeof policy === 'string') return [];
  return (policy.members[person.personId]?.storeIds ?? []).filter(storeId => decideAccess(raw, person, capability, storeId, platform).allowed);
}

export type PolicyUpdateResult = { ok: true; version: number } | { ok: false; reason: 'invalid' | 'version_conflict' | 'version_not_increasing' };
/**
 * 版本化变更：事务内先锁高水位行、再锁策略行（FOR UPDATE），校验 expectedVersion（null=当前缺失或损坏）与高水位，
 * 同事务写入新策略、高水位和审计记录。与提交事务的 FOR SHARE 读互斥，先后确定。
 */
export async function updateAccessPolicy(store: PerformanceStore, input: { expectedVersion: number | null; next: AccessPolicy; actor: string; reason: string; at: string }): Promise<PolicyUpdateResult> {
  const nextRaw = JSON.stringify(input.next);
  const parsed = parseAccessPolicy(nextRaw);
  if (!parsed || parsed === 'missing' || !id(input.actor)) return { ok: false, reason: 'invalid' };
  let outcome: PolicyUpdateResult = { ok: false, reason: 'version_conflict' };
  // M08：策略行不存在时 FOR UPDATE 锁不到任何行，两个 expectedVersion=null 的写者会都成功（后写覆盖）。
  // 先确保高水位行存在（'0' 与缺失同义），并把它作为第一把锁：所有策略变更在它上面串行，拿到锁后才读策略行。
  await store.insertConfigIfAbsent(ACCESS_POLICY_HIGH_WATER_KEY, '0');
  await store.updateConfigLocked(ACCESS_POLICY_HIGH_WATER_KEY, [ACCESS_POLICY_KEY], current => {
    const old = parseAccessPolicy(current[ACCESS_POLICY_KEY] ?? null);
    const oldVersion = old && old !== 'missing' ? old.version : null;
    if (oldVersion !== input.expectedVersion) { outcome = { ok: false, reason: 'version_conflict' }; return null; }
    const highWater = Number(current[ACCESS_POLICY_HIGH_WATER_KEY] ?? '0');
    const floor = Math.max(Number.isSafeInteger(highWater) ? highWater : Number.MAX_SAFE_INTEGER, oldVersion ?? 0);
    if (parsed.version <= floor) { outcome = { ok: false, reason: 'version_not_increasing' }; return null; }
    outcome = { ok: true, version: parsed.version };
    const audit = JSON.stringify({ version: parsed.version, previousVersion: oldVersion, actor: input.actor, reason: input.reason, at: input.at,
      members: Object.fromEntries(Object.entries(parsed.members).map(([personId, grant]) => [personId, { role: grant.role, storeIds: grant.storeIds, status: grant.status }])) });
    return { [ACCESS_POLICY_KEY]: nextRaw, [ACCESS_POLICY_HIGH_WATER_KEY]: String(parsed.version), [`${ACCESS_AUDIT_PREFIX}${parsed.version}`]: audit };
  });
  return outcome;
}
