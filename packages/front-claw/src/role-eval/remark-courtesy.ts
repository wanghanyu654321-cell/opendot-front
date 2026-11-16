/**
 * D135（定稿）：致谢客套。
 * 词表按类别放在 config/remark-courtesy.json，匹配只按表里的短语最长优先，
 * 不做同义词路由（不会把「谢谢」写成「谢啦」的别名）。
 * 只有整段都是客套语才剥掉；「谢谢，不过没做」整段按备注交给 D130。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RemarkCourtesyConfig {
  courtesy: string[];
}

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../config/remark-courtesy.json');
const FILLER = /[\s，,。．.!！?？、；;：:（）()【】[\]《》""''…—–·~～\p{Extended_Pictographic}\uFE0F\u200D]+/gu;
const LEADING_FILLER = /^(?:[\s，,。．.!！?？、；;：:（）()【】[\]《》""''…—–·~～\p{Extended_Pictographic}\uFE0F\u200D]+)/u;

let cached: RemarkCourtesyConfig | null = null;

function normalizeConfig(raw: Partial<RemarkCourtesyConfig> | null | undefined): RemarkCourtesyConfig {
  const list = Array.isArray(raw?.courtesy)
    ? [...new Set(raw!.courtesy.map(x => String(x).normalize('NFKC').trim()).filter(Boolean))]
    : [];
  return { courtesy: list.sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh')) };
}

export function loadRemarkCourtesyConfig(source?: string | RemarkCourtesyConfig): RemarkCourtesyConfig {
  if (source && typeof source === 'object') {
    cached = normalizeConfig(source);
    return cached;
  }
  const path = typeof source === 'string' && source.trim() ? source.trim() : CONFIG_PATH;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RemarkCourtesyConfig;
  cached = normalizeConfig(raw);
  return cached;
}

export function remarkCourtesyConfig(): RemarkCourtesyConfig {
  return cached ?? loadRemarkCourtesyConfig();
}

export function courtesyPhrases(): readonly string[] {
  return remarkCourtesyConfig().courtesy;
}

/**
 * 只有整段都是客套语才剥掉。返回去掉客套后的正文，以及被剥掉的短语（若有）。
 * 整段由客套短语（可夹填充/标点，可连续多枚）拼完 → rest 为空。
 * 只要剩下不认识的字，一处都不剥，rest 为原文（「谢谢，不过没做」「不错谢谢」）。
 */
export function stripTrailingCourtesy(text: string): { rest: string; courtesy: string | null } {
  if (typeof text !== 'string') return { rest: '', courtesy: null };
  const original = text.normalize('NFKC').trim();
  if (!original) return { rest: '', courtesy: null };
  const phrases = courtesyPhrases();
  if (!phrases.length) return { rest: original, courtesy: null };
  let s = original;
  const taken: string[] = [];
  let guard = 0;
  while (s.length && guard++ < 16) {
    const lead = LEADING_FILLER.exec(s);
    if (lead) s = s.slice(lead[0].length);
    if (!s) break;
    const hit = phrases.find(p => s.startsWith(p));
    if (!hit) return { rest: original, courtesy: null };
    taken.push(hit);
    s = s.slice(hit.length);
  }
  const leftover = s.replace(FILLER, '').trim();
  if (leftover) return { rest: original, courtesy: null };
  if (!taken.length) return { rest: original, courtesy: null };
  return { rest: '', courtesy: taken.join('') };
}

export { CONFIG_PATH as REMARK_COURTESY_CONFIG_PATH };
