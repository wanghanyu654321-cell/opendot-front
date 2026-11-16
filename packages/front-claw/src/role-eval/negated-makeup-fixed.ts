/**
 * D142 固定否定补报说法：词表在 config/negated-makeup-fixed.json，R16 起不再往里扩。
 * 剥离行为与 R15 冻结时一致（含 R15 收入的「不是补昨天」「不是昨天那种补报」）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NegatedMakeupFixedConfig {
  version: string;
  pastDayPattern: string;
  feifei: string;
  r15AddedPatterns: string[];
  r15Added: string[];
  phrasesForReport: string[];
}

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../config/negated-makeup-fixed.json');

let cached: NegatedMakeupFixedConfig | null = null;

export function loadNegatedMakeupFixedConfig(source?: string | NegatedMakeupFixedConfig): NegatedMakeupFixedConfig {
  if (source && typeof source === 'object') {
    cached = source;
    return cached;
  }
  const path = typeof source === 'string' && source.trim() ? source.trim() : CONFIG_PATH;
  cached = JSON.parse(readFileSync(path, 'utf8')) as NegatedMakeupFixedConfig;
  return cached;
}

/** 与 R15 冻结时相同的固定剥离正则（边界：不把「并非补上」误剥成「并非补」；上周的「上」放过）。 */
export function fixedNegatedMakeupRegex(): RegExp {
  const c = loadNegatedMakeupFixedConfig();
  const past = c.pastDayPattern;
  // D173：R15 新收的两个时间结构只用配置 phrasesForReport 中的「不是」，
  // 不把基础短语的四种否定词乘到时间结构；其余交 D168 unseen-makeup 先问。
  const notBranch = String.raw`(?:不(?:是|算|要|用)(?:在补(?:报|记)?|补(?:报|记|的))|不是(?:补(?:${past})|(?:${past})那种补报))(?:的)?`;
  const feifei = c.feifei;
  const body = String.raw`(?:${notBranch}|${feifei})(?!录|登|单|漏)(?!上(?!周|个|星期))`;
  return new RegExp(String.raw`[，,;；、。.\s]*${body}(?:的)?(?:${past})?(?:的)?(?:补报|补记|报|记|单)?[，,;；、。.\s]*`, 'g');
}

export function stripFixedNegatedMakeup(s: string): string {
  if (!s) return s;
  const next = s
    .replace(fixedNegatedMakeupRegex(), '')
    .replace(/^[，,;；、。.\s]+/, '')
    .replace(/[，,;；、。.\s]+$/, '')
    .trim();
  return next;
}
