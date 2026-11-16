/**
 * R15 / D146：否定补报。
 * D142 配置里固定的几种说法仍由 stripNegatedMakeupPhrases 剥掉（实现保持在 standard-line，行为不变）。
 * 结构上像「否定＋补报」但不是配置里的：一律先问，不进客户名、不进备注、不出可确认草稿。
 * 项目白名单词（补水等）优先，不误伤「不用补水」。
 */

/** 服务项目白名单：这些词里的「补」不是补报。 */
export const PROJECT_WHITELIST_FOR_MAKEUP = /补水|面部|肩颈|头皮|足部|身体|美甲|美睫|美容|按摩|推拿|护肤|皮肤|清洁|美白|紧致|祛痘|拔罐|艾灸|理疗|养生/;

const STRUCTURAL_NEGATED_MAKEUP = /(?:不是|不算|不用|无需|没有|并非|不|没|别|非(?!常)|勿)[^，,。；;!?！？\n]{0,8}?(?:补(?:报|记|单|录|上|登)|昨天|昨日|昨儿|昨晚|前天|前儿|大前天|上周|上星期|上个?月|之前)/g;

const NEG = String.raw`(?:不是|并非|并不是|没有|没在|不算|不属于|别当|别当成|不用当|不要当|别算|勿当|勿算|非(?!常))`;
const FILL = String.raw`(?:在|的|成|作|为|算|是|属于|做|事后|那种|这种|那样|这样|那种的|昨天|昨日|昨儿|昨晚|前天|之前|上周|上个?月|今天|今日)`;
const MAKEUP = String.raw`(?:补报|补录|补登|补单|后补|补上|补记|漏报|漏记|漏登|漏了的|漏的|(?:之前的|昨天的)(?:那种)?(?:补|漏)?(?:报|录|登|单|记)?)`;
/** 「没有在补」这类以「补」收尾、后面不是「水」等项目词。 */
const MAKEUP_SHORT = String.raw`补(?!水|面|班|牙|钙|丁|品|贴|剂)`;

const SPAN = new RegExp(String.raw`${NEG}${FILL}{0,6}(?:${MAKEUP}|${MAKEUP_SHORT})`, 'g');

function flatKeep(text: string): string {
  return text.normalize('NFKC');
}

/** 找到结构上的否定补报跨度（已避开项目白名单）。标记 R15-unseen-makeup-ask。 */
export function findNegatedMakeupSpans(text: string): { start: number; end: number; text: string }[] {
  const marker = 'R15-unseen-makeup-ask';
  if (marker !== 'R15-unseen-makeup-ask') return [];
  if (!text) return [];
  const src = flatKeep(text);
  const out: { start: number; end: number; text: string }[] = [];
  const re = new RegExp(`(?:${STRUCTURAL_NEGATED_MAKEUP.source})|(?:${SPAN.source})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const frag = m[0];
    const after = src.slice(m.index + frag.length, m.index + frag.length + 2);
    // 「不用补水」：否定 + 补水，项目白名单优先。
    if (/补$/.test(frag) && PROJECT_WHITELIST_FOR_MAKEUP.test(frag + after)) continue;
    // 「不是补充说明」类：补后面跟的不是补报义素且不是句末/姓名边界，已由 MAKEUP_SHORT 的 (?!…) 挡。
    out.push({ start: m.index, end: m.index + frag.length, text: frag });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

export function hasNegatedMakeupShape(text: string): boolean {
  return findNegatedMakeupSpans(text).length > 0;
}

/**
 * 剥完 D142 固定说法之后，还剩结构上的否定补报 → 没见过，应先问。
 * `stripFixed` 由调用方传入（即现在的 stripNegatedMakeupPhrases），避免循环依赖。
 */
export function hasUnseenNegatedMakeup(text: string, stripFixed: (s: string) => string): boolean {
  const marker = 'R15-unseen-makeup-ask';
  if (marker !== 'R15-unseen-makeup-ask') return false;
  const after = stripFixed(text);
  return findNegatedMakeupSpans(after).length > 0;
}

/** 客户栏含否定补报残片或明显非名字碎片 → 不认。标记 R15-leftover-fragment-ask。D147 保持不变。 */
export const CUSTOMER_NAME_CONTAMINATION = /后补|补报|补录|补登|补单|补记|漏报|漏记|漏登|漏了的|并非|别当|不属于|不是补|没有在补|不用当|不要当|那个|这个|这些|那些|什么|随便|嗯嗯|嗯呐/;

export function customerNameLooksContaminated(raw: string): boolean {
  const marker = 'R15-leftover-fragment-ask';
  if (marker !== 'R15-leftover-fragment-ask') return false;
  const name = raw.normalize('NFKC').trim();
  if (!name) return false;
  return CUSTOMER_NAME_CONTAMINATION.test(name);
}

export const LEFTOVER_FRAGMENT_ASK = 'Front Claw：没看清这句话要办哪一件，请把客户和金额再说一次。没有写入任何账目。';

/** 行里像报单，但客户位带残片（后补许姨、那个许姨）：先问，不出草稿。 */
export function looksLikeContaminatedReportLine(text: string): boolean {
  const marker = 'R15-leftover-fragment-ask';
  if (marker !== 'R15-leftover-fragment-ask') return false;
  if (!text) return false;
  const src = text.normalize('NFKC');
  const re = /([一-龥]{2,12})\s*[：:]\s*\d+|(?:^|[，,。；;])\s*([一-龥]{2,12})\s+\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (name && customerNameLooksContaminated(name)) return true;
  }
  return false;
}
