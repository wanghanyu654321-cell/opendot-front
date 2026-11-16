import { MAX_ENTRY_AMOUNT, MAX_TARGET_AMOUNT } from './amounts.js';
import { guardAmountTerm } from './amount-guard.js';
/**
 * M04 账本指令解析（纯函数，不读库、不写库）：目标设置与更正（改金额 / 撤回）。
 * 只认明确说法；缺对象、缺金额或同时要改又要撤都返回 invalid，由调用方回澄清，不猜。
 */
const AMOUNT = String.raw`(\d{1,15}(?:\.\d{1,8})?)\s*(w|W|万|千|k|K|元)?`;

/**
 * 「5w」「3万」「3.5万」「4千」「5k」「30000」「600元」→ 整数分；其他返回 null。
 * R2：改用 amounts.ts 的十进制规则（不经浮点、不取整）：超过两位小数 / 0 / 负数 / 超技术上界 → null（调用方回「无效」并不写入）。
 */
export function parseAmount(raw: string, max = MAX_TARGET_AMOUNT): number | null {
  // R7：改账/目标金额走同一道校验。「0.33w」「3k」「1.2万」有单位直接收；「2000出头」拒绝。
  const g = guardAmountTerm(raw, 'free', max);
  return g.ok ? g.cents : null;
}

const SELF = /^(?:我|我的|本人|我自己|自己)?$/;
const strip = (name: string) => name.replace(/的$/, '').trim();

export interface TargetCommand { personName: string | null; periodMonth: string; amount: number }
/**
 * 「本月目标 5w」「给小赵定本月目标3万」「小赵12月目标 30000」「把小钱下个月目标改成4万」「这个月目标定为6万」。
 * 必须带金额；不带金额的“目标”是进度查询，返回 null。personName=null 表示本人。
 */
export function parseTargetCommand(text: string, businessDay: string): TargetCommand | 'invalid' | null {
  const flat = text.replace(/\s+/g, '');
  if (!/目标/.test(flat) || /多少|完成|进度|还差|[?？]/.test(flat)) return null;
  const match = new RegExp(String.raw`^(?:给|帮|把|将)?(.{0,12}?)(?:的)?(?:定|设|设置|设定)?(?:一下)?(本月|这个月|这月|下个月|下月|\d{1,2}月)(?:的|份)?(?:业绩)?目标(?:定为|定成|设为|设成|改为|改成|调为|调成|调到|定|设|改|是|为|：|:|到)?${AMOUNT}$`).exec(flat);
  if (!match) return /目标(?:定|设|改|调|是|为|：|:)?\d/.test(flat) ? 'invalid' : null;
  const amount = parseAmount(`${match[3]}${match[4] ?? ''}`);
  const periodMonth = resolvePeriod(match[2]!, businessDay);
  if (!amount || !periodMonth) return 'invalid';
  const name = strip(match[1] ?? '');
  return { personName: SELF.test(name) ? null : name, periodMonth, amount };
}

function resolvePeriod(raw: string, businessDay: string): string | null {
  const year = Number(businessDay.slice(0, 4)), month = Number(businessDay.slice(5, 7));
  const fmt = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
  if (/^(?:本月|这个月|这月)$/.test(raw)) return fmt(year, month);
  if (/^(?:下个月|下月)$/.test(raw)) return month === 12 ? fmt(year + 1, 1) : fmt(year, month + 1);
  const n = Number(/^(\d{1,2})月$/.exec(raw)?.[1]);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  // 只设本月或以后的目标：小于当前月的月份按明年算。
  return n >= month ? fmt(year, n) : fmt(year + 1, n);
}

export type CorrectionCommand =
  | { action: 'amend'; amount: number; index: number | null; personName: string | null; customerName?: string | null; originalAmount?: number | null }
  | { action: 'withdraw'; index: number | null; personName: string | null; customerName?: string | null; originalAmount?: number | null };

const REFERENCE = /刚才|刚刚|上一笔|上笔|最近一笔|最后一笔|那笔|这笔|第\d{1,2}笔/;
const WITHDRAW = /撤回|撤销|作废|删掉|删除|不算了?|取消掉/;
const AMEND = /改|更正|报错|写错|填错|记错|应该是|应为/;
/**
 * 「把刚才那笔改成600」「撤回刚才的报数」「把刚才第2笔改成300」「刚才那笔金额报错了，应该是480」「把小赵刚才那笔改成900」。
 * 必须指向“刚才/上一笔/第N笔”；没有指向（如单独「撤回」「改成600」）返回 null。
 */
const HONOR = '阿姨|奶奶|爷爷|先生|女士|小姐|老师|姐姐|哥哥|姐|姨|哥|叔|总|嫂|婶';
const CUST = String.raw`[\u4e00-\u9fa5](?:${HONOR})`;

const CN_ORD: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * 「改 2」「改2」——从今日已报清单里点第 N 笔。不是「改成600」。
 * R7：放宽自然说法——「第二个」「改第二笔」「改刚才那笔」。
 * `listedCount` 用于把「刚才那笔」落到清单最后一笔（最近的）；不传则「刚才那笔」视为第 1 笔。
 */
export function parseCorrectionPick(text: string, listedCount?: number): { index: number } | null {
  const flat = text.trim().normalize('NFKC').replace(/\s+/g, '').replace(/[。.!！啊吧呀呢哦嘛哈～~]+$/g, '');
  const exact = /^改第?([1-9]\d?)笔?$/.exec(flat);
  if (exact) return { index: Number(exact[1]) };
  const cn = /^(?:改(?:一下)?)?第?([一二两三四五六七八九十]|[1-9]\d?)(?:个|笔|条|单)$/.exec(flat);
  if (cn) {
    const n = CN_ORD[cn[1]!] ?? Number(cn[1]);
    return Number.isInteger(n) && n >= 1 ? { index: n } : null;
  }
  // 「改刚才那笔 / 改刚刚那笔 / 刚才那笔」：有多笔时取最近（清单末尾）。
  if (/^(?:改(?:一下)?(?:刚才|刚刚)(?:的)?那[一]?笔|改刚才那笔|刚才那笔|刚刚那笔)$/.test(flat)) {
    const n = listedCount !== undefined && listedCount > 0 ? listedCount : 1;
    return { index: n };
  }
  return null;
}

/** R6/R7 数据兜底：员工选择「新增一笔」。R7 放宽自然说法（新加的、是另一单…）。 */
export function parseAddNewChoice(text: string): boolean {
  const flat = text.trim().normalize('NFKC').replace(/\s+/g, '').replace(/[。.!！啊吧呀呢哦嘛哈～~]+$/g, '');
  // D126：允许从句（「那就再记一笔吧」）；有新金额则不是在选「新增」。
  if (!flat || flat.length > 48) return false;
  if (/\d/.test(flat) && /[元块万千kKwW]|：|:|（|\(/.test(flat)) return false;
  return /(?:新增一笔|新增|加一笔|再记一笔|另记一笔|再登一笔|另登一笔|新的一笔|是新增|记新的|作为新的一笔|新加的|新加一笔|是另一单|是另外一单|另外一单|另一单|再来一笔|再加一笔|新的一单|是新的|加新的|不是改(?:的|账)?是新的)/.test(flat);
}

/** R7：普通员工对别人的单选择「找店长改」——不写账。 */
export function parseAskManagerChoice(text: string): boolean {
  const flat = text.trim().normalize('NFKC').replace(/\s+/g, '').replace(/[。.!！啊吧呀呢哦嘛哈～~]+$/g, '');
  if (!flat || flat.length > 24) return false;
  return /^(?:找店长改|请店长改|让店长改|找店长|请店长来改|店长改|让店长来改)$/.test(flat);
}

/**
 * R4：点名客户的更正。「把许姐那笔改成860」「把我今天已报许姐680那笔改成860」。
 * 从改账分句取客户（复合句里取「改成」前最近的客人称呼），可选原金额。
 */
function parseNamedCorrection(flat: string): CorrectionCommand | 'invalid' | null {
  const withdraw = WITHDRAW.test(flat);
  const amendTail = new RegExp(String.raw`(?:把|将)?(?:我(?:今天|今日)?(?:已经?报(?:的|了)?)?)?(${CUST})(?:的)?(?:(\d{1,15}(?:\.\d{1,8})?)\s*(w|W|万|千|k|K|元)?)?(?:那笔|这笔|那单|这单|那一笔|这一笔)?(?:改成|改为|改到|更正为|更正成)(\d{1,15}(?:\.\d{1,8})?)\s*(w|W|万|千|k|K|元)?(?:元)?[。.!！]*$`).exec(flat);
  const withdrawTail = withdraw ? new RegExp(String.raw`(?:把|将)?(?:我(?:今天|今日)?(?:已经?报(?:的|了)?)?)?(${CUST})(?:的)?(?:(\d{1,15}(?:\.\d{1,8})?)\s*(w|W|万|千|k|K|元)?)?(?:那笔|这笔|那单|这单|那一笔|这一笔)(?:撤回|撤销|作废|删掉|删除|不算了?)`).exec(flat) : null;
  const hit = amendTail ?? withdrawTail;
  if (!hit) return null;
  // 必须有「那笔」类指代，或同时有原金额和新金额，避免把普通报数当成更正。
  if (!/(?:那笔|这笔|那单|这单|那一笔|这一笔)/.test(flat) && !(hit[2] && amendTail)) return null;
  const customerName = hit[1]!;
  const originalAmount = hit[2] ? parseAmount(`${hit[2]}${hit[3] ?? ''}`, MAX_ENTRY_AMOUNT) : null;
  if (hit[2] && originalAmount === null) return 'invalid';
  if (withdrawTail && !amendTail) return { action: 'withdraw', index: null, personName: null, customerName, originalAmount };
  const amount = parseAmount(`${amendTail![4]}${amendTail![5] ?? ''}`, MAX_ENTRY_AMOUNT);
  if (!amount) return 'invalid';
  return { action: 'amend', amount, index: null, personName: null, customerName, originalAmount };
}

export function parseCorrectionCommand(text: string): CorrectionCommand | 'invalid' | null {
  const flat = text.replace(/\s+/g, '');
  const named = parseNamedCorrection(flat);
  if (named) return named;
  if (!REFERENCE.test(flat) || flat.length > 80) return null;
  const withdraw = WITHDRAW.test(flat);
  const amountMatch = new RegExp(String.raw`(?:改成|改为|改到|更正为|更正成|应该是|应为|是)${AMOUNT}(?:元)?[。.!！]*$`).exec(flat);
  const amend = AMEND.test(flat) && !!amountMatch;
  if (!withdraw && !AMEND.test(flat)) return null;
  const index = /第(\d{1,2})笔/.exec(flat);
  const who = /^(?:帮我)?(?:把|将|撤回|撤销|作废|删掉|删除)(.{1,8}?)(?:的)?(?:刚才|刚刚|最近|上一|最后)/.exec(flat);
  const name = who ? strip(who[1]!) : '';
  const personName = SELF.test(name) ? null : name;
  const position = index ? Number(index[1]) : null;
  if (position !== null && position < 1) return 'invalid';
  if (withdraw && amend) return 'invalid';
  if (withdraw) return { action: 'withdraw', index: position, personName };
  if (!amountMatch) return 'invalid';
  const amount = parseAmount(`${amountMatch[1]}${amountMatch[2] ?? ''}`, MAX_ENTRY_AMOUNT);
  return amount ? { action: 'amend', amount, index: position, personName } : 'invalid';
}
