import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// D170：共享配置形态读取，不依赖标准行/名单模块，避免语法与政策循环初始化。
const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../config/customer-name-policy.json', import.meta.url)), 'utf8')) as { surnames: { singles: string[]; compounds: string[] }; nicknamePrefixes: string[] };
const STRUCTURE_CONFIG = Object.freeze({
  singles: Object.freeze([...raw.surnames.singles]),
  compounds: Object.freeze([...raw.surnames.compounds]),
  nicknamePrefixes: Object.freeze([...raw.nicknamePrefixes]),
});

/** 未知客户位的结构底线：配置单姓/复姓＋1–2 字名，或配置昵称前缀＋1 字。 */
export function matchesCustomerNameStructure(name: string): boolean {
  const n = name.normalize('NFKC').replace(/\s+/g, '').trim();
  if (!n || !/^[\u4e00-\u9fa5]+$/.test(n)) return false;
  const cfg = STRUCTURE_CONFIG;
  if (n.length === 2 && cfg.nicknamePrefixes.includes(n[0]!) && /^[\u4e00-\u9fa5]$/.test(n[1]!)) return true;
  for (const compound of cfg.compounds) {
    if (n.startsWith(compound)) {
      const rest = n.slice(compound.length);
      if (rest.length >= 1 && rest.length <= 2 && /^[\u4e00-\u9fa5]+$/.test(rest)) return true;
    }
  }
  if (n.length >= 2 && n.length <= 3 && cfg.singles.includes(n[0]!)) {
    const rest = n.slice(1);
    if (rest.length >= 1 && rest.length <= 2 && /^[\u4e00-\u9fa5]+$/.test(rest)) return true;
  }
  return false;
}

