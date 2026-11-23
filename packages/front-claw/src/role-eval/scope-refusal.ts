import type { Capability } from './access-policy.js';
import type { Person } from './performance-store.js';
import { looksLikeAppointment, withoutAppointmentCoaching } from './appointments.js';

/**
 * R3：通用的「不能做」规则与几类直接答复（不针对任何具体原句）。
 * - 越权/跨店：直接说「不能做」并给原因，不追问、不读不写。
 * - 客套话：短答一句，不写账、不追问。
 * - 非今天的报数（D81 已定口径）：固定一句，不追问。
 * 全部是纯函数；权限判断由调用方传入（与入账门同一判定）。
 */
const F = 'Front Claw';
export const cannot = (reason: string): string => `${F}：不能做——${reason}。没有读取或写入任何账目。`;
export const NOT_TODAY_REPLY = `${F}：目前只能报今天的单，补报请找店长。`;
export const COURTESY_THANKS = `${F}：不客气，有事随时找我。`;
export const COURTESY_MORNING = `${F}：早～有事随时找我。`;
export const COURTESY_BYE = `${F}：辛苦了，明天见～`;
export const COURTESY_OTHER = `${F}：好的～有事随时找我。`;

// 只做全半角/空白归一（不做同义词替换，避免改写原话）。
const flatOf = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

/** 查询类说法：问「多少/业绩/进度/排名/汇总」之类，而不是报一笔。 */
const QUERY = /查|看|瞧|拉|给我|发来|汇总|排名|排行|多少|业绩|进度|完成/;
const METRIC = /业绩|进度|干了多少|做了多少|报了多少|完成了?多少|入账多少|多少钱|多少单|还差多少|离目标|几单|明细|没报|目标/;
const STORE_WIDE = /排名|排行|汇总|所有人|全店|全部人|大家|各店|谁(?:还)?没报|(?:还有)?谁没报|谁没有报|列名单|总共|总业绩|一共/;

export interface RefusalContext {
  actor: Person;
  people: readonly Person[];
  /** 与入账门同一判定：actor 在 storeId 上是否有该能力。 */
  allowed: (capability: Capability, storeId: string) => Promise<boolean>;
}

const STORE_SHORT_NAME = /(?:测试)?(?:[一二三四五六七八九十]|(?<![a-z0-9])[2-9a-z])店(?!长|员|务|铺|面)|分店|总店|外店|他店|别的店|其他店/gi;

/** 识别显式门店简称，并排除本店名称中的简称。 */
export function otherStoreShortNames(text: string, ownStoreName: string): string[] {
  const own = flatOf(ownStoreName).toLowerCase();
  return [...flatOf(text).matchAll(STORE_SHORT_NAME)].map(([name]) => name)
    .filter(name => !own.includes(name.toLowerCase().replace(/^测试/, '')));
}

/** 文本里点名的他店，简称优先回显目录中的门店名。 */
export function otherStoresNamed(text: string, people: readonly Person[], actor: Person): string[] {
  const flat = flatOf(text).toLowerCase();
  const own = flatOf(actor.storeName).toLowerCase();
  const names = [...new Set(people.filter(p => p.storeId !== actor.storeId).map(p => p.storeName).filter(name => typeof name === 'string' && name.trim()))]
    .map(name => ({ name, normalized: flatOf(name).toLowerCase() })).filter(({ normalized }) => !own.includes(normalized));
  const named = names.filter(({ normalized }) => flat.includes(normalized));
  const stores = new Set(named.map(({ name }) => name));
  for (const shortName of otherStoreShortNames(text, actor.storeName)) {
    const suffix = shortName.toLowerCase();
    if (named.some(({ normalized }) => normalized.endsWith(suffix))) continue;
    stores.add(names.find(({ normalized }) => normalized.endsWith(suffix))?.name ?? shortName);
  }
  return [...stores];
}
/** 文本里点名的本店同事（目录里的显示名，不含本人）。 */
export function colleaguesNamed(text: string, people: readonly Person[], actor: Person): Person[] {
  const flat = flatOf(text);
  return people.filter(p => p.personId !== actor.personId && typeof p.displayName === 'string' && p.displayName.length >= 2 && flat.includes(p.displayName));
}

/**
 * 越权/跨店 → 「不能做」+原因；不越权 → null（由原流程处理）。
 * 顺序：跨店（任何店务说法）→ 查别人的业绩 → 全店排名/汇总。
 */
/** 已由管理查询入口回答的固定说法（「查不到」/无权），这里不抢先改口，也不提前读花名册。 */
/** R6：格式明确、在权限内的查询应直接办。覆盖「查一下我今天的进度」「查本店业绩」「看今天的单」等自然说法。 */
export function isSelfProgressQuery(text: string): boolean {
  const flat = flatOf(text);
  if (/^(?:我的进度|今天进度|进度)$/.test(flat)) return true;
  if (/金额|元|块|报一笔|记一笔|改成|改账/.test(flat) && /\d/.test(flat)) return false;
  if (/\d/.test(flat)) return false;
  return /^(?:请?帮?(?:我)?)?(?:查询|查看|查查|看看|查|看|问|列)(?:一?下|查|看)?(?:我|本人)(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?(?:进度|业绩|已入账|入账结果?|(?:做了|完成了?|报了)(?:多少|几单|什么)?(?:业绩|单|钱)?|完成)(?:是?(?:多少|怎样|怎么样))?(?:吧|啊|呢|吗)?[?？。！!]*$/.test(flat)
    || /^(?:请)?(?:帮我|给我)(?:查询|查看|查查|看看|查|看|问|列)(?:一?下)?(?:的)?(?:今天|今日|本月|这个月|这月)(?:的)?(?:进度|业绩|已入账|入账结果?|(?:做了|完成了?|报了)(?:多少|几单|什么)(?:业绩|单|钱)?|完成(?:情况|度)?)(?:是?(?:多少|怎样|怎么样))?(?:吧|啊|呢|吗)?[?？。！!]*$/.test(flat)
    || /^(?:我|本人)(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?(?:进度|业绩|已入账)(?:是?(?:多少|怎样|怎么样))?(?:吧|啊|呢|吗)?[?？。！!]*$/.test(flat)
    || /^(?:请?帮?(?:我)?)?(?:查询|查看|查|看|列)(?:一?下)?(?:我|本人)?(?:的)?今天(?:的)?(?:单|报数|入账|已入账|已报)(?:吧|啊|呢|吗)?[?？。！!]*$/.test(flat);
}
export function isStorePerfQuery(text: string): boolean {
  const flat = flatOf(text);
  if (/金额|报一笔|记一笔|改成/.test(flat) && /\d/.test(flat)) return false;
  return /^(?:请?帮?(?:我)?)?(?:查|看)(?:一?下)?(?:本店|我们店|门店|本店今天|本店本月)(?:的)?(?:今天|今日|本月)?(?:的)?(?:业绩|汇总|完成|进度|完成率)(?:吧|啊|呢)?$/.test(flat)
    || /^(?:本店|我们店)(?:今天|今日|本月)?(?:的)?(?:业绩|汇总)(?:是?(?:多少))?(?:吧|啊|呢)?$/.test(flat)
    || /^(?:经营汇总|门店汇总|本店汇总|本月汇总)(?:\s+\S+)?$/.test(flat);
}
export const otherProgressCommand = /^(\S{1,12}?)的(?:今天|本月)?进度$/;
export const missingReportsCommand = /^(?:今天)?谁(?:还)?没报(?:\s+(\S+))?$/;
export const storeRankingCommand = /^门店(?:排名|排行)$/;

/** An explicit label in the source remains binding when the classifier omits the slot. */
export function labelledStoreTargets(text: string): string[] | null {
  const normalized = text.normalize('NFKC');
  const targets = new Set<string>();
  const labels = normalized.matchAll(/(?:门店|分店)(编号|编码|ID)?(\s*:\s*|\s*)/gi);
  for (const label of labels) {
    const rest = normalized.slice(label.index! + label[0].length);
    const marked = !!label[1] || label[2]!.includes(':');
    if (!marked && /^(?:这边|这儿|最近|今天|今日|本月|的|业绩|排名|排行|经营|汇总|进度|情况|表现|有哪些|是什么|[?。!]|$)/.test(rest)) continue;
    const field = rest.split(/(?:的?(?:业绩|进度|经营|汇总|表现|情况|本月|今天|今日))|[?。!；;]/u, 1)[0]!.trim();
    const names = field.split(/(?:、|,|和|与|或者|以及|及)(?=[^。?]*?(?:店|[A-Za-z0-9]))/u)
      .map(name => name.trim().replace(/^(?:门店|分店)\s*:?\s*/, '').trim());
    if (names.some(name => !/^[\p{Script=Han}\w.-]{1,120}$/u.test(name))) return null;
    for (const name of names) targets.add(name);
  }
  return [...targets];
}

export function isManagedQueryPhrase(text: string): boolean {
  const flat = flatOf(text);
  return missingReportsCommand.test(text.trim()) || storeRankingCommand.test(flat) || otherProgressCommand.test(flat)
    || /^(?:我的进度|今天进度|进度|经营汇总\S*|谁没报\S*|门店排名)$/.test(flat)
    || /^(?:[\u4e00-\u9fa5]{1,8}的进度)$/.test(flat)
    || isSelfProgressQuery(text)
    || isStorePerfQuery(text);
}

export async function scopeRefusal(text: string, ctx: RefusalContext): Promise<string | null> {
  const { actor, people } = ctx;
  const flat = flatOf(text);
  const others = otherStoresNamed(text, people, actor);
  if (others.length) return cannot(`只能办本店（${actor.storeName}）的事，${others.join('、')}的报数和查询都不行（跨店不能代报，也不能查）`);
  // 设/改目标：无权限直接拒绝，不把「目标没说清」留给格式澄清。
  if (/目标/.test(flat) && /(?:定|设|改|调|设置|设定)/.test(flat) && !/多少|还差|完成|进度|[?？]/.test(flat)) {
    if (!await ctx.allowed('target_set', actor.storeId)) return cannot('你没有权限设或改目标，这个需要店长来');
  }
  // R5：老板不能报单（带金额且不是查询/改账/设目标）。改账、撤回、设目标不算报单。
  if (actor.tier === 'owner' && /\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flat)
    && !QUERY.test(flat) && !STORE_WIDE.test(flat) && !isManagedQueryPhrase(text)
    && !/改|更正|撤回|撤销|作废|目标/.test(flat)) {
    return cannot('老板不能报单');
  }
  // 带金额的是报数（含代报），不按「查询」规则拦。共有「一共/总共 + 金额」也是报数合计，不是全店汇总查询。
  // 「还有谁没报」一类全店问法本身就是查询，不必再要求「查/看/多少」。
  if (/\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flat)) return null;
  if (!QUERY.test(flat) && !STORE_WIDE.test(flat)) return null;
  const namedAll = colleaguesNamed(text, people, actor);
  const named = namedAll.filter(p => p.storeId === actor.storeId);
  const namedOther = namedAll.filter(p => p.storeId !== actor.storeId);
  if (namedOther.length && METRIC.test(flat)) {
    return cannot(`只能办本店（${actor.storeName}）的事，不能查${namedOther.map(p => p.displayName).join('、')}（${[...new Set(namedOther.map(p => p.storeName))].join('、')}）的业绩`);
  }
  if (named.length && METRIC.test(flat) && !await ctx.allowed('progress_other', actor.storeId)) {
    return cannot(`你没有权限查同事（${named.map(p => p.displayName).join('、')}）的业绩，这个需要店长来查；查自己的请发「我的进度」`);
  }
  // 目录未收录的「小X/老X」问法，同样不能查别人（不要求名字已在花名册里）。
  if (!namedAll.length && METRIC.test(flat)) {
    const nicks = [...flat.matchAll(/(?:小|老)[\u4e00-\u9fa5]{1,2}/g)].map(m => m[0]).filter(n => n !== actor.displayName && !/^(?:小姐|老师|小姐姐)$/.test(n));
    if (nicks.length) return cannot(`你没有权限查同事（${[...new Set(nicks)].join('、')}）的业绩，这个需要店长来查；查自己的请发「我的进度」`);
  }
  if (STORE_WIDE.test(flat) && !await ctx.allowed('store_summary', actor.storeId) && !await ctx.allowed('stores_ranking', actor.storeId)) {
    return cannot('你没有权限看全店的排名和汇总，这个需要店长来；查自己的请发「我的进度」');
  }
  return null;
}

/** 客套话：去掉寒暄/致谢词与语气词、标点、表情后什么都不剩。 */
const COURTESY_TOKENS = /谢谢你|谢谢您|谢谢啦|谢谢|谢啦|多谢|感谢|辛苦了|辛苦啦|辛苦|早上好|早安|早呀|早啊|早|晚安|下班啦|下班了|明天见|拜拜|再见|回见|加油鸭|加油呀|加油|今天也|你们|你|您|大家|啦|呀|鸭|哈|啊|哦|嘛|了|呢|吧/g;
const THANKS = /谢|辛苦/;
export function courtesyKind(text: string): 'thanks' | 'morning' | 'bye' | 'other' | null {
  const flat = flatOf(text);
  if (!flat || flat.length > 30 || /\d/.test(flat)) return null;
  if (!new RegExp(COURTESY_TOKENS.source).test(flat)) return null;
  const rest = flat.replace(COURTESY_TOKENS, '').replace(/[\p{P}\p{S}\p{Extended_Pictographic}\uFE0F\u200D~～]/gu, '');
  if (rest.length) return null;
  return THANKS.test(flat) ? 'thanks' : /晚安|明天见|拜拜|再见|回见|下班/.test(flat) ? 'bye' : /早/.test(flat) ? 'morning' : 'other';
}
const COURTESY: Record<NonNullable<ReturnType<typeof courtesyKind>>, string> = { thanks: COURTESY_THANKS, morning: COURTESY_MORNING, bye: COURTESY_BYE, other: COURTESY_OTHER };
/**
 * R3a：吐槽/情绪类（「累鼠了」「烦死了」）与客套话同样处理：短答一句，不写账、不追问。
 * 泛化规则：有情绪/状态词，且没有任何店务信号——金额、店务动作、客人称谓、预约时间、营销素材词都没有。带金额的一律照常走报数。
 */
export const COURTESY_VENT = `${F}：辛苦了，先歇口气～有事随时找我。`;
const EMOTION = /累|困|烦|忙|乏|饿|晕|酸|疼|痛|麻了|头大|崩溃|难受|郁闷|无语|气死|心塞|想哭|哭了|唉|哎|没睡|吐槽|开心|快乐|高兴|心情|压力|焦虑|emo|丧|躺平|摸鱼|顶不住|扛不住|受不了/i;
const AMOUNT_LIKE = /\d+(?:\.\d+)?\s*(?:元|块|k|w|千|万)|\d{2,}|[一二两三四五六七八九十百千万]+\s*(?:元|块)/i;
const STORE_ACTION = /报|记|销售|开单|成交|\d+\s*单|查|看下|看看|约|改|撤|删|取消|确认|登记|入账|清单|业绩|进度|目标|汇总|排名|排行|操作号|文案|海报|朋友圈|小红书|推广|翻译|算一?下/;
const CUSTOMER_TITLE = /[\u4e00-\u9fa5](?:姐|哥|姨|叔|总|老师|先生|女士|阿姨)/;
const APPOINT_TIME = /明天|后天|大后天|下周|下星期|[0-9一二三四五六七八九十]+\s*[点时]/;
export function isVent(text: string): boolean {
  const flat = flatOf(text);
  if (!flat || flat.length > 40) return false;
  if (AMOUNT_LIKE.test(flat) || STORE_ACTION.test(flat) || CUSTOMER_TITLE.test(flat) || APPOINT_TIME.test(flat)) return false;
  return EMOTION.test(flat);
}
export const courtesyReply = (text: string): string | null => {
  const kind = courtesyKind(text);
  if (kind) return COURTESY[kind];
  return isVent(text) ? COURTESY_VENT : null;
};

/** D81：非今天的报数（昨天/前天/上周/某月某日…加金额的报数说法）。查询不算。 */
// 只认相对的过去日期词；带「N号」标题的清单由 M01 入口按营业日判定（同一口径）。
const PAST_DAY = /昨天|昨儿|昨日|昨晚|昨儿晚|前天|前儿|大前天|上周|上星期|上个?礼拜|上个?月/;
const FUTURE_DAY = /明天|明日|明儿|后天|大后天/;
const REPORT_SHAPE = /(?:报|记|登记|补报|补一笔|补记|代补|开单|成交|先记|先登|先计|帮我登|帮我记|帮.{0,4}登)|[姐哥姨叔总老师女士][^\d]{0,8}\d/;
function explicitReportDay(flat: string, today: string): string | null {
  // 不用「.」当日期分隔（会把 1.25k、1.2 当成 1月25日/1月2日）。
  const ymd = /(?:(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?)|(?:(\d{1,2})月(\d{1,2})[日号]?)/.exec(flat);
  if (!ymd) return null;
  const year = ymd[1] ? Number(ymd[1]) : Number(today.slice(0, 4));
  const month = Number(ymd[2] ?? ymd[4]), day = Number(ymd[3] ?? ymd[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
/** 否定里的「昨天/补报」不是在报过去的单（「不是昨天那种补报」）。 */
export function maskNegatedPastDay(text: string): string {
  // D124：否定式补报整段去掉。推广「不是（在）补（报）（昨天/前天/上周的）」；
  // 报单本身是今天时，这些日期不触发非今天拒。保留既有「不是补报」「并非昨天那种」。
  const PAST = String.raw`(?:昨天|昨日|昨儿|昨晚|前天|前儿|大前天|上周|上星期|上个?礼拜)`;
  return text
    .replace(new RegExp(String.raw`不(?:是|算|要|用)(?:在)?补(?:报|记)?(?:的)?${PAST}(?:的)?(?:补报|补记|报|记|单)?`, 'g'), '')
    .replace(new RegExp(String.raw`并非(?:在)?补(?:报|记)?(?:的)?${PAST}(?:的)?(?:单|报|记)?`, 'g'), '')
    .replace(/不(?:是|算|要|用)补(?:昨天|昨日|昨儿|前天)?(?:的)?(?:补报|补记|报|记|单)?/g, '')
    .replace(/不(?:是|算|要|用)(?:昨天|昨日|昨儿|前天|那种)*(?:的)?(?:补报|补记|补上|补昨天|补前天|单)?/g, '')
    .replace(/并非(?:昨天|昨日|前天|那种)*(?:的)?(?:补报|补记)?/g, '')
    .replace(/不是补报/g, '');
}

export function pastDayReportPhrase(text: string, today?: string): boolean {
  // 只看前半句（复合句后半句里的「昨天那单」是另一件事，由复合句规则处理）。
  const flat = maskNegatedPastDay(flatOf(compoundHead(text)));
  // 纯预约（明天几点来/给我登记一下，没有成交金额）不当「非今天的报数」。
  // 金额须紧跟称谓或带货币单位，避免把「明天15点」或「阿姨…15点」当成成交金额。
  const moneyish = /(?:\d+(?:\.\d+)?\s*(?:元|块钱|块|[kKwW千万])|[一二三四五六七八九十百千万]{2,}\s*(?:元|块)?|(?:姐|哥|姨|叔|女士|先生|阿姨|老师)\s*\d{2,})/;
  // 明说不用登记/取消预约，不是补报昨天的单。
  if (/(?:不用|不要|别)(?:登记|改单|办)|只是?吐槽|我就说说|我就吐槽/.test(flat) && /约|预约|取消/.test(flat)) return false;
  if (/取消/.test(flat) && /约/.test(flat) && !/(?:补报|补记|算我|业绩|没来得及报)/.test(flat) && !moneyish.test(flat)) return false;
  if (looksLikeAppointment(text) && !moneyish.test(flat) && !/(?:补报|补记|算我|业绩|没来得及报)/.test(flat)) return false;
  if (/(?:约|来店|到店|预约)/.test(flat) && !/(?:报|记|登记|补记|补报|业绩|算我)/.test(flat) && !moneyish.test(flat)) return false;
  if (/查|看|多少|进度|业绩到/.test(flat) && !/报|记|登记|补记|代补/.test(flat)) return false;
  const amountish = /\d{1,}(?:\.\d+)?[kKwW千万元块]?|[一二三四五六七八九十百千万]{1,}[元块]?/.test(flat);
  const reportish = REPORT_SHAPE.test(flat) || /补|先记|先登|先计/.test(flat);
  if (PAST_DAY.test(flat)) {
    if (reportish || (amountish && /报|记|登|补|业绩/.test(flat))) return true;
    if (/记|登|报|补/.test(flat)) return true;
  }
  // 「明天再说」不是把明天的单报进来；只有明天/后天和成交金额或报数动作在一起才算非今天的报数。
  if (FUTURE_DAY.test(flat) && !/再说|再聊|以后再|回头再/.test(flat)) {
    if (reportish || (amountish && /报|记|登|补|业绩/.test(flat))) return true;
  }
  if (today) {
    const day = explicitReportDay(flat, today);
    if (day && day !== today && (reportish || (amountish && /店|姐|姨|业绩|补|记|报|登/.test(flat)))) return true;
  }
  return false;
}

/**
 * 复合句：「…，再/然后/顺便 …」后半句。返回后半句文本（已去连接词），没有则 null。
 * 只认句中的顺接连接词；前半句为空不算。
 */
const CONNECTOR = /[，,。；;！!]\s*(?:然后再|然后|再帮我|再给我|再|顺便|顺带|同时|另外|还有)|(?:然后再|然后|顺便|顺带|同时)/;
const PUNCT_SPLIT = /[，,。；;！!\n]/;

function looksLikeReportHead(head: string): boolean {
  const flat = flatOf(head);
  if (!flat) return false;
  return /(?:姐|哥|姨|叔|老师|先生|女士|阿姨|总|嫂|婶)\s*\d/.test(flat)
    || /[：:]\s*\d/.test(flat)
    || /\d+(?:\.\d+)?\s*[（(]/.test(flat)
    || (/(?:报|记|登|算我|我的单)/.test(flat) && /(?:\d|[零〇一二两三四五六七八九十百千万])/.test(flat));
}

function splitCompound(text: string): { head: string; tail: string } | null {
  const t = text.normalize('NFKC').trim();
  if (!t) return null;
  const m = CONNECTOR.exec(t);
  if (m && m.index > 0) {
    const tail = t.slice(m.index + m[0].length).replace(/^[，,;；。.\s]+/, '').trim();
    if (tail.length >= 2) return { head: t.slice(0, m.index), tail };
  }
  // 句号、逗号、分号、换行后：前半是报单、后半确定是另一件店务才拆。
  // 「明天下午两点来做头疗，帮我约上」是同一件预约，不拆（否则后半没有钟点）。
  const punct = PUNCT_SPLIT.exec(t);
  if (punct && punct.index > 0) {
    const head = t.slice(0, punct.index);
    const tail = t.slice(punct.index + punct[0].length).replace(/^[，,;；。.\s]+/, '').trim();
    if (tail.length >= 2 && looksLikeReportHead(head)) {
      const k = clauseKind(tail);
      if (k && k !== 'report') return { head, tail };
    }
  }
  // 行尾备注以连接词开头（逗号/句号被切进备注里）：后半句确定是另一件店务才当复合。
  // 必须排在「改成」中部切分前面，避免「。然后把上一笔改成1280」被切成备注「然后把上一笔」。
  const lead = /^(?:[，,。；;！!\s]*)(?:然后再|然后|再帮我|再给我|再|顺便|顺带|同时|另外|还有)(.*)$/.exec(t);
  if (lead) {
    const tail = (lead[1] ?? '').replace(/^[，,;；。.\s]+/, '').trim();
    if (tail.length >= 2) {
      const k = clauseKind(tail);
      if (k && k !== 'report') return { head: '', tail };
    }
  }
  // 无标点时，报单后面紧跟确定的改账分句也拆开，避免改账金额把本行吞成非标准行。
  // 「上一笔/刚才那笔」算确定改账；不单独用裸「改成」从中间切开。
  const amend = /(?:把|将)?(?:刚才|刚刚|最近|上一笔|上一单|最后一笔|上一|最后)(?:的)?(?:那笔|这笔|那单|这单)?|(?:把|将)?(?:那笔|这笔|那单|这单)/.exec(t);
  if (amend && amend.index >= 0) {
    const after = t.slice(amend.index);
    if (/(?:改成|改为|改到|更正|撤回|撤销)/.test(after) && clauseKind(after) === 'correction') {
      const head = t.slice(0, amend.index).replace(/[，,;；。.\s]+$/, '').trim();
      const tail = after.trim();
      if (tail.length >= 2) {
        if (head.length >= 2) return { head, tail };
        if (head.length === 0) return { head: '', tail };
      }
    }
  }
  return null;
}

export function compoundHead(text: string): string {
  const t = text.normalize('NFKC').trim();
  return splitCompound(t)?.head ?? t;
}
export function compoundTail(text: string): string | null {
  const t = text.normalize('NFKC').trim();
  return splitCompound(t)?.tail ?? null;
}
/** 后半句是不是「查本人今天/本月的进度/已入账」（不带别人、不带历史时段）。 */
export function selfProgressPhrase(text: string): boolean {
  const flat = flatOf(text);
  if (/昨天|前天|上周|上个?月|那段|那天|之前/.test(flat)) return false;
  return /^(?:帮我|给我)?(?:查|看)(?:下|一下|查|看)?(?:我自己|我本人|本人|我)(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?(?:已入账|入账|业绩|进度|做了|完成)/.test(flat);
}

export type ClauseKind = 'report' | 'correction' | 'appointment' | 'marketing' | 'progress' | 'query' | 'target';

/** 分句大致意图（泛化，不针对原句）。 */
export function clauseKind(part: string): ClauseKind | null {
  const flat = flatOf(part);
  if (!flat || flat.length < 2) return null;
  if (selfProgressPhrase(part) || /查(?:我|本人).*(?:进度|业绩|入账)/.test(flat)) return 'progress';
  if (/改成|改为|更正|撤回|撤销|那笔改|这笔改/.test(flat)) return 'correction';
  if (looksLikeAppointment(part) || /(?:预约|登记.{0,8}点)/.test(withoutAppointmentCoaching(flat))) return 'appointment';
  if (/海报|文案|朋友圈|小红书|宣传|推广|种草|标语/.test(flat)) return 'marketing';
  if (/目标/.test(flat) && /定|设|改|调/.test(flat)) return 'target';
  if (/(?:报|记|登|算我|我的单|先给我报)/.test(flat) && /(?:\d|[一二三四五六七八九十百千万])/.test(flat)) return 'report';
  if (/查|汇总|排名|拉给|算下|还差|几单|明细/.test(flat)) return 'query';
  if (/(?:做|写|发|给|帮).{1,12}/.test(flat) && flat.length >= 4) return 'marketing';
  return null;
}

/**
 * R4（R3A-03）：已办了一种店务之后，把句子里其他动作明确标成「没办」。
 * 报单＋本人进度是已支持组合（D96），不当未办。
 */
export function leftoverNote(text: string, handled: ClauseKind): string | null {
  const tail = compoundTail(text);
  const head = compoundHead(text);
  if (!tail || head === text) return null;
  const headK = clauseKind(head);
  const tailK = clauseKind(tail);
  const other = tailK === handled ? (headK && headK !== handled ? head : null)
    : headK === handled ? (tailK && tailK !== handled ? tail : (tailK === null && tail.length >= 2 ? tail : null))
    : (tailK && tailK !== handled ? tail : (headK && headK !== handled ? head : tail));
  if (!other) return null;
  const k = clauseKind(other);
  if (handled === 'report' && k === 'progress') return null;
  if (k === handled) return null;
  if (!k && other === tail && tail.length < 2) return null;
  // 后半句即使分不出具体种类，只要像另一件店务，也要明说没办（不再因带数字而跳过）。
  if (!k && !/(?:做|写|发|给|帮|查|约|改|设|算|海报|文案|预约|登记|目标|汇总|排名|还差|几单|明细)/.test(flatOf(other))) return null;
  const headText = head.trim();
  if (handled === 'report' && k === 'correction' && headText) {
    return `前半句「${headText}」已进待确认草稿。后半句「${other.trim()}」这次没有办：一条消息只办一件店务，请单独再发。`;
  }
  return `后半句「${other.trim()}」这次没有办：一条消息只办一件店务，请单独再发。`;
}

/** 预约只用预约分句解析客户，避免串用前半句报单的客人。 */
export function appointmentClause(text: string): string {
  const tail = compoundTail(text);
  if (tail && (looksLikeAppointment(tail) || /预约|登记.{0,8}点/.test(withoutAppointmentCoaching(flatOf(tail))))) return tail;
  const head = compoundHead(text);
  if (head !== text && (looksLikeAppointment(head) || /预约/.test(withoutAppointmentCoaching(flatOf(head))))
      && tail && !looksLikeAppointment(tail) && !/预约/.test(withoutAppointmentCoaching(flatOf(tail)))) return head;
  return text;
}

/** A complete read-only question. Discard only framing and explicit negative clauses. */
export type BusinessRead = { kind: 'self' | 'identity' | 'unsupported' } | { kind: 'summary'; store?: string } | { kind: 'managed' | 'existing'; command: string };
export function businessRead(text: string): BusinessRead | undefined {
  const request = text.normalize('NFKC').trim()
    .replace(/^[A-Za-z]+-[A-Za-z]*\d+\s*:\s*/, '')
    .replace(/^我(?:现在)?自称[^。！？!?\n]+[。！？!?]\s*/, '')
    .replace(/^只读(?:查询|核对)\s*:?\s*/, '')
    .replace(/[?？。;；，,]\s*不(?:报单|创建门店|改权限|扩权|预约|改账|发布)(?:[、，,]\s*不(?:报单|创建门店|改权限|扩权|预约|改账|发布))*[。.!！]?$/, '')
    .replace(/[?？。;；]+$/, '').trim();
  if (/^我(?:当前)?(?:实际)?(?:业务身份和)?(?:获|被)?授权门店(?:是什么|有哪些)$/.test(request)) return { kind: 'identity' };
  if (isSelfProgressQuery(request) || /^我(?:本月|今天)?的?(?:业绩(?:进度)?|进度)(?:是多少|多少)?$/.test(request)) return { kind: 'self' };
  const query = request.replace(/^(?:请|帮我|给我)?(?:查一下|查询|查看|核对|看看|查|看)\s*/, '');
  const named = /^(?:(?:[\p{Script=Han}]{1,12}的)?门店\s*)?([\w.-]+|[\p{Script=Han}]{1,20}店)\s*的?\s*(?:本月|今日|今天)?(?:全店)?(?:业绩(?:汇总)?|进度)(?:是多少|多少)?$/u.exec(query);
  const command = /^(?:经营汇总|门店汇总|本店汇总|本月汇总)(?:\s+([^\s]+))?$/.exec(request);
  if (isStorePerfQuery(request) && !command?.[1]) return { kind: 'summary' };
  if (named) {
    const target = named[1]!;
    return /^(?:本店|全店)$/.test(target) ? { kind: 'summary' } : { kind: 'summary', store: target };
  }
  if (otherProgressCommand.test(request) || missingReportsCommand.test(request) || storeRankingCommand.test(request)) return { kind: 'managed', command: request };
  if (command) return command[1] ? { kind: 'summary', store: command[1] } : { kind: 'summary' };
  if (/^(?:(?:我(?:想|要))?(?:看|查|核对)|门店|分店)/.test(request) && /业绩|经营情况/.test(request)
      && !/报单|报数|记账|改账|预约|设目标|撤回|确认入账/.test(request)) {
    const targets = labelledStoreTargets(request);
    if (!targets || targets.length > 1) return { kind: 'unsupported' };
    if (targets[0]) return { kind: 'summary', store: targets[0] };
  }
  if (existingReadCommand(request)) return { kind: 'existing', command: request };
  if (/^(?:[A-Za-z]+-[A-Za-z]*\d+[：:]\s*)?只读(?:查询|核对)/.test(text.trim())) return { kind: 'unsupported' };
  return undefined;
}

/** Read commands whose handlers need the current draft or appointment view. */
export function existingReadCommand(text: string): boolean {
  return /^(?:入账结果(?:\s+\S+)?|我的预约|预约结果|我登记的预约|查.{0,8}预约|预约列表|(?:今天|明天|本店)的?预约)$/.test(text);
}
