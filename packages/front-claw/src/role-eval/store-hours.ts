import { DEFAULT_BUSINESS_CUTOFF, DEFAULT_TIME_ZONE } from './metrics.js';

/**
 * R1（M06-06）：按门店读取营业配置（时区、打烊时刻）。PG config 键 front-claw-store-hours：
 *   {"version":1,"stores":{"s-b":{"timeZone":"Asia/Shanghai","cutoff":"23:00"}}}
 * 未配置的门店用默认值（Asia/Shanghai / 23:00）。配置存在但损坏（坏 JSON、未知字段、非法时区/时刻）→ null，调用方不写入。
 * 草稿保存的是按该规则算出的绝对过期时间；配置变更不改已存在草稿（D66）。
 */
export const STORE_HOURS_KEY = 'front-claw-store-hours';
export interface StoreHours { timeZone: string; cutoff: string }
const CUTOFF = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}
export function resolveStoreHours(raw: string | null, storeId: string, defaults: StoreHours = { timeZone: DEFAULT_TIME_ZONE, cutoff: DEFAULT_BUSINESS_CUTOFF }): StoreHours | null {
  if (raw === null) return { ...defaults };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'version' && key !== 'stores') || body.version !== 1) return null;
  const stores = body.stores;
  if (!stores || typeof stores !== 'object' || Array.isArray(stores)) return null;
  const entry = (stores as Record<string, unknown>)[storeId];
  if (entry === undefined) return { ...defaults };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  if (Object.keys(e).some(key => key !== 'timeZone' && key !== 'cutoff')) return null;
  const timeZone = e.timeZone === undefined ? defaults.timeZone : e.timeZone;
  const cutoff = e.cutoff === undefined ? defaults.cutoff : e.cutoff;
  if (!validTimeZone(timeZone) || typeof cutoff !== 'string' || !CUTOFF.test(cutoff)) return null;
  return { timeZone, cutoff };
}
