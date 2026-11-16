/**
 * D130：行尾备注正向白名单。
 * 词表按类别放在 config/remark-whitelist.json，不写死在匹配逻辑里。
 * 整条备注必须都能被白名单词拼完（中间可有空白/标点）；只是包含某个白名单词不能放行。
 * 项目名一类通过 ProjectNameSource 留接口，以后把门店项目表合并进来。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RemarkWhitelistCategory = 'customerType' | 'payment' | 'praise' | 'project';

export interface RemarkWhitelistConfig {
  customerType: string[];
  payment: string[];
  praise: string[];
  project: string[];
}

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../config/remark-whitelist.json');

let cached: RemarkWhitelistConfig | null = null;

export function loadRemarkWhitelistConfig(source?: string | RemarkWhitelistConfig): RemarkWhitelistConfig {
  if (source && typeof source === 'object') {
    cached = normalizeConfig(source);
    return cached;
  }
  const path = typeof source === 'string' && source.trim() ? source.trim() : CONFIG_PATH;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RemarkWhitelistConfig;
  cached = normalizeConfig(raw);
  return cached;
}

function normalizeConfig(raw: RemarkWhitelistConfig): RemarkWhitelistConfig {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.map(x => String(x).normalize('NFKC').trim()).filter(Boolean))] : [];
  return {
    customerType: list(raw.customerType),
    payment: list(raw.payment),
    praise: list(raw.praise),
    project: list(raw.project),
  };
}

export function remarkWhitelistConfig(): RemarkWhitelistConfig {
  return cached ?? loadRemarkWhitelistConfig();
}

/**
 * 门店项目名接口：默认返回配置里的 project 类。
 * 以后接门店项目表时，用 setProjectNameSource 换成按 storeId 查表，再与配置合并。
 */
export type ProjectNameSource = (ctx?: { storeId?: string }) => readonly string[];

let projectNameSource: ProjectNameSource = () => remarkWhitelistConfig().project;

export function setProjectNameSource(source: ProjectNameSource | null): void {
  projectNameSource = source ?? (() => remarkWhitelistConfig().project);
}

export function projectNamesForStore(ctx?: { storeId?: string }): readonly string[] {
  try {
    return projectNameSource(ctx) ?? remarkWhitelistConfig().project;
  } catch {
    return remarkWhitelistConfig().project;
  }
}

/** 所有类别的短语（含当前门店项目名），按长度从长到短，避免短词抢匹配。 */
export function allWhitelistPhrases(ctx?: { storeId?: string; extraProjects?: readonly string[] }): string[] {
  const cfg = remarkWhitelistConfig();
  const projects = [...projectNamesForStore(ctx), ...(ctx?.extraProjects ?? [])];
  const all = [...cfg.customerType, ...cfg.payment, ...cfg.praise, ...projects]
    .map(p => p.normalize('NFKC').trim())
    .filter(Boolean);
  return [...new Set(all)].sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh'));
}

const FILLER_CLASS = '[\\s，,。．.!！?？、；;：:（）()【】[\\]《》""\'\'…—–·~～\\p{Extended_Pictographic}\\uFE0F\\u200D]';
const FILLER = new RegExp(`${FILLER_CLASS}+`, 'gu');
const LEADING_FILLER = new RegExp(`^(?:${FILLER_CLASS}+)`, 'u');

/**
 * 整条备注是否完全由白名单词组成。
 * 「不错」→ true；「老客微信」→ true；「不错但没做」→ false（有剩余「但没做」）。
 */
export function isWhitelistedRemark(remark: string, ctx?: { storeId?: string; extraProjects?: readonly string[] }): boolean {
  if (typeof remark !== 'string') return false;
  let s = remark.normalize('NFKC').trim();
  if (!s) return true;
  const phrases = allWhitelistPhrases(ctx);
  if (!phrases.length) return false;
  while (s.length) {
    s = s.replace(LEADING_FILLER, '');
    if (!s) return true;
    const hit = phrases.find(p => s.startsWith(p));
    if (!hit) return false;
    s = s.slice(hit.length);
  }
  return true;
}

/** 默认路径就是白名单。可保留常量，但不提供旧的「其他备注直接出草稿」默认实现。 */
export const REMARK_DRAFT_POLICY = 'whitelist' as const;

export { FILLER, CONFIG_PATH as REMARK_WHITELIST_CONFIG_PATH };
