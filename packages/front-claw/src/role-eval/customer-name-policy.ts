/**
 * D140：客户名政策 A/B/C（默认 C，见 config/customer-name-policy.json）。
 * D165：带不带员工括号的客户位使用相同三档；姓＋称谓保持 D125 正向形态。
 * 判定在员工入口、完整解析之后：不缩小 parse。命中后或直接出草稿，或只问「是新客户「X」吗？」且不附可确认草稿（D139 修订）。
 */
import { matchesCustomerNameStructure } from './customer-name-structure.js';
export { matchesCustomerNameStructure } from './customer-name-structure.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOMER_HONORIFIC, HONORIFIC, NOT_CUSTOMER_NAME, isExactHonorificCustomerName } from './standard-line.js';
import {
  collectKnownCustomerNames,
  nameInRoster,
  type RosterStore,
} from './store-customer-roster.js';

export type CustomerNamePolicyMode = 'A' | 'B' | 'C';
export type NamePolicyDecision = 'deny' | 'allow' | 'ask-new';

export interface CustomerNamePolicyConfig {
  mode: CustomerNamePolicyMode;
  surnames: { source: string; singles: string[]; compounds: string[] };
  nicknamePrefixes: string[];
  formatConflicts: { items: { word: string; reason: string }[] };
}

interface LoadedPolicy {
  mode: CustomerNamePolicyMode;
  singles: Set<string>;
  compounds: string[];
  nicknamePrefixes: string[];
  conflictWords: Set<string>;
  source: string;
}

const CONFIG_REL = '../../config/customer-name-policy.json';
let cached: LoadedPolicy | null = null;
let testMode: CustomerNamePolicyMode | null = null;

function loadPolicy(): LoadedPolicy {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(join(here, CONFIG_REL), 'utf8')) as CustomerNamePolicyConfig;
  const mode = raw.mode === 'A' || raw.mode === 'B' || raw.mode === 'C' ? raw.mode : 'C';
  const compounds = [...(raw.surnames?.compounds ?? [])].sort((a, b) => b.length - a.length);
  cached = {
    mode,
    singles: new Set(raw.surnames?.singles ?? []),
    compounds,
    nicknamePrefixes: raw.nicknamePrefixes ?? ['小', '阿', '老'],
    conflictWords: new Set((raw.formatConflicts?.items ?? []).map(i => i.word)),
    source: raw.surnames?.source ?? '',
  };
  return cached;
}

/** 测试或评测切换模式；传 null 恢复配置文件。进程环境 CUSTOMER_NAME_POLICY_MODE 优先于本覆盖。 */
export function setCustomerNamePolicyModeForTest(mode: CustomerNamePolicyMode | null): void {
  testMode = mode;
}

export function resetCustomerNamePolicyCache(): void {
  cached = null;
  testMode = null;
}

export function getCustomerNamePolicyMode(): CustomerNamePolicyMode {
  const env = process.env.CUSTOMER_NAME_POLICY_MODE?.trim().toUpperCase();
  if (env === 'A' || env === 'B' || env === 'C') return env;
  if (testMode) return testMode;
  return loadPolicy().mode;
}

export function customerNamePolicyConfig(): LoadedPolicy {
  return loadPolicy();
}

const HONOR_PARTS = HONORIFIC.split('|').sort((a, b) => b.length - a.length);

/** 姓＋称谓必须整段恰好匹配（「周老师」「钱姐」）。前面挂残片的（「后补许姨」「今天的钱姐」）不算称谓，不走快通道。 */
export function isHonorificCustomerName(name: string): boolean {
  return isExactHonorificCustomerName(name ?? '');
}

export function isPolicySubject(item: { self?: boolean | undefined; customer?: string | null }): boolean {
  const name = (item.customer ?? '').normalize('NFKC').trim();
  if (!name) return false;
  if (isHonorificCustomerName(name)) return false;
  return true;
}

export function hitsNotCustomerName(name: string): boolean {
  const n = name.normalize('NFKC').trim();
  return !n || NOT_CUSTOMER_NAME.test(n);
}

/** B 模式正向格式额外排除冲突整词和非名字词；不改变 A/C 的 D139 三档口径。 */
export function matchesPositiveNameFormat(name: string): boolean {
  const n = name.normalize('NFKC').replace(/\s+/g, '').trim();
  return !loadPolicy().conflictWords.has(n) && !hitsNotCustomerName(n) && matchesCustomerNameStructure(n);
}

export function decideOpenedCustomerName(
  name: string,
  opts: { known: boolean; mode?: CustomerNamePolicyMode },
): NamePolicyDecision {
  const n = name.normalize('NFKC').trim();
  if (hitsNotCustomerName(n)) return 'deny';
  if (isHonorificCustomerName(n)) return 'allow';
  const mode = opts.mode ?? getCustomerNamePolicyMode();
  if (mode === 'A') return 'ask-new';
  if (mode === 'B') return matchesPositiveNameFormat(n) ? 'allow' : 'ask-new';
  // C：本店已知客户直接出草稿，其余先问（D139 修订）。
  return opts.known ? 'allow' : 'ask-new';
}

export type OpenedNamesPolicy =
  | { kind: 'allow' }
  | { kind: 'deny'; names: string[] }
  | { kind: 'ask-new'; names: string[] };

export async function decideOpenedNamesPolicy(
  store: RosterStore,
  storeId: string,
  items: ReadonlyArray<{ customer: string | null; self?: boolean | undefined }>,
): Promise<OpenedNamesPolicy> {
  const opened = items.filter(isPolicySubject) as Array<{ customer: string; self?: boolean }>;
  if (!opened.length) return { kind: 'allow' };
  const mode = getCustomerNamePolicyMode();
  const known = await collectKnownCustomerNames(store, storeId);
  const deny: string[] = [];
  const ask: string[] = [];
  for (const item of opened) {
    const decision = decideOpenedCustomerName(item.customer, {
      known: nameInRoster(known, item.customer),
      mode,
    });
    if (decision === 'deny') deny.push(item.customer);
    else if (decision === 'ask-new') ask.push(item.customer);
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  if (deny.length) return { kind: 'deny', names: uniq(deny) };
  if (ask.length) return { kind: 'ask-new', names: uniq(ask) };
  return { kind: 'allow' };
}

export function newCustomerAskKey(personId: string, sessionId: string): string {
  return `employee-loop:new-customer-ask:${personId}:${sessionId}`;
}

/** 只这一句，不附可确认草稿（D139 修订）。 */
export function newCustomerAskReply(names: readonly string[]): string {
  if (names.length === 1) return `Front Claw：是新客户「${names[0]}」吗？`;
  return `Front Claw：是新客户${names.map(n => `「${n}」`).join('、')}吗？`;
}

/** D172：肯定追问只出草稿，入账仍要再回一次「对」。 */
export function isYesNewCustomerReply(text: string): boolean {
  const t = text.normalize('NFKC').trim();
  return /^(是的?|是呀|是啊|是呢|对的?)[。．\.!！]?$/.test(t);
}

export function notCustomerNameAskReply(names: readonly string[]): string {
  // R17 / D153：非名字不再问「是新客户吗」，用通用追问。
  return NOT_A_CUSTOMER_NAME_ASK;
}

/** D153：非名字的通用追问，不出现「是新客户吗」，不带可确认草稿。 */
export const NOT_A_CUSTOMER_NAME_ASK = 'Front Claw：这句话不像在报客户名，请把要报的客户和金额单独再发一行。没有写入任何账目。';

/** 门①单独报数：新客户首报追问（是新客户「X」吗？且无草稿）。 */
export function isNewCustomerFirstAskReply(reply: string): boolean {
  return /是新客户[「『"]/.test(reply);
}
