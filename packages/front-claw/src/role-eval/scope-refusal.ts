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
export const HISTORICAL_PERIOD_UNSUPPORTED = `${F}：当前仅支持查询今天、本旬和本月的业绩与汇总，暂不支持查询历史月份。没有读取或写入任何账目。`;
export const COURTESY_THANKS = `${F}：不客气，有事随时找我。`;
export const COURTESY_MORNING = `${F}：早～有事随时找我。`;
export const COURTESY_BYE = `${F}：辛苦了，明天见～`;
export const COURTESY_OTHER = `${F}：好的～有事随时找我。`;

// 只做全半角/空白归一（不做同义词替换，避免改写原话）。
const flatOf = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

/** 查询类说法：问「多少/业绩/进度/排名/汇总」之类，而不是报一笔。 */
const QUERY = /查|看|瞧|拉|给我|发来|汇总|排名|排行|多少|业绩|进度|完成/;
const METRIC = /业绩|进度|干了多少|做了多少|报了多少|完成了?多少|入账多少|多少钱|多少单|还差多少|离目标|几单|明细|没报|目标/;
const STORE_WIDE = /排名|排行|汇总|所有人|全店|全部人|大家|各店|谁(?:还)?没报|(?:还有)?谁没报|谁没有报|列名单|总业绩/;
const STORE_TOTAL_WORD = /总共|一共/;

export interface ExtractedScopeConstraints {
  /** 去掉显式否定排除分句（「别的店不要」「不要其他店」）后的文本，保留正向门店限定。 */
  withoutExcludedOtherStores: string;
  /** 再去掉独立「只查本店/仅看本店」尾巴后的主请求文本。 */
  positiveText: string;
  /** 被用户显式排除的他店表达（如 ['别的店']）。 */
  excludedOtherStores: string[];
  /** 用户显式限定只查/只看本店。 */
  ownStoreOnly: boolean;
  /** 用户显式强调「已授权/获授权」。 */
  onlyAuthorized: boolean;
}

const EXCLUDED_OTHER_STORE_SUFFIX = /[，,。；;、\s]*(别的店|其他店|其它店|外店|他店|别的门店|其他门店|其它门店)(?:都)?(?:不要|不用|别看|别查|不算|不看|不查|除外)/g;
const EXCLUDED_OTHER_STORE_PREFIX = /[，,。；;、\s]*(?:不要|不用|别看|别查|不看|不查|不含|不包含|排除|不算)(别的店|其他店|其它店|外店|他店|别的门店|其他门店|其它门店)/g;
const OWN_STORE_ONLY_CLAUSE = /[，,。；;、\s]*(?:只|仅|只要|只需|只限|仅限)(?:查|看|限)?(?:本店|本门店|当前门店|自己门店)(?=$|[，,。；;！？!?\s])/g;

/** 抽取并保留用户的范围约束（「别的店不要」「只查本店」「已授权」），避免把排除约束误判成跨店请求或静默丢弃。 */
export function extractScopeConstraints(text: string): ExtractedScopeConstraints {
  const normalized = text.normalize('NFKC').trim();
  const excluded: string[] = [];
  const collect = (pattern: RegExp, input: string): string =>
    input.replace(pattern, (_match, store: string) => {
      if (store && !excluded.includes(store)) excluded.push(store);
      return '';
    });
  const withoutExcluded = collect(EXCLUDED_OTHER_STORE_PREFIX, collect(EXCLUDED_OTHER_STORE_SUFFIX, normalized))
    .replace(/^[，,。；;、\s]+|[，,。；;、\s]+$/g, '')
    .trim();
  let ownStoreOnly = false;
  const positiveText = withoutExcluded
    .replace(OWN_STORE_ONLY_CLAUSE, () => {
      ownStoreOnly = true;
      return '';
    })
    .replace(/^[，,。；;、\s]+|[，,。；;、\s]+$/g, '')
    .trim();
  const onlyAuthorized = /(?:已|获|被)授权/.test(normalized);
  return {
    withoutExcludedOtherStores: withoutExcluded,
    positiveText: positiveText || withoutExcluded,
    excludedOtherStores: excluded,
    ownStoreOnly,
    onlyAuthorized,
  };
}

export interface RefusalContext {
  actor: Person;
  people: readonly Person[];
  /** 与入账门同一判定：actor 在 storeId 上是否有该能力。 */
  allowed: (capability: Capability, storeId: string) => Promise<boolean>;
}

const STORE_SHORT_NAME = /(?:测试)?(?:[一二三四五六七八九十]|(?<![a-z0-9])[2-9a-z])店(?!长|员|务|铺|面)|分店|总店|外店|他店|别的店|其他店/gi;

/** 识别显式门店简称，并排除本店名称中的简称及明确排除的他店（「别的店不要」）。 */
export function otherStoreShortNames(text: string, ownStoreName: string): string[] {
  const own = flatOf(ownStoreName).toLowerCase();
  const positive = extractScopeConstraints(text).withoutExcludedOtherStores;
  return [...flatOf(positive).matchAll(STORE_SHORT_NAME)].map(([name]) => name)
    .filter(name => !own.includes(name.toLowerCase().replace(/^测试/, '')));
}

/** 文本里点名的他店，简称优先回显目录中的门店名。 */
export function otherStoresNamed(text: string, people: readonly Person[], actor: Person): string[] {
  const positive = extractScopeConstraints(text).withoutExcludedOtherStores;
  const flat = flatOf(positive).toLowerCase();
  const own = flatOf(actor.storeName).toLowerCase();
  const names = [...new Set(people.filter(p => p.storeId !== actor.storeId).map(p => p.storeName).filter(name => typeof name === 'string' && name.trim()))]
    .map(name => ({ name, normalized: flatOf(name).toLowerCase() })).filter(({ normalized }) => !own.includes(normalized));
  const named = names.filter(({ normalized }) => flat.includes(normalized));
  const stores = new Set(named.map(({ name }) => name));
  for (const shortName of otherStoreShortNames(positive, actor.storeName)) {
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
/** 识别历史月份/年份查询（已先排除「不是补上个月」类否定补报）。 */
export function hasUnsupportedHistoricalPeriod(text: string, businessDay?: string): boolean {
  const masked = maskNegatedPastDay(flatOf(text));
  if (/上个?月|去年|前年|上季度|上半年|往月|历史月(?:份)?/.test(masked)) return true;
  if (businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    const curYear = Number(businessDay.slice(0, 4));
    const curMonth = Number(businessDay.slice(5, 7));
    const ym = /(20\d{2})(?:年|[-/])(\d{1,2})月?/.exec(masked);
    if (ym) {
      const y = Number(ym[1]), m = Number(ym[2]);
      if (m >= 1 && m <= 12 && (y < curYear || (y === curYear && m < curMonth))) return true;
    }
    const mOnly = /(?<![\d年])(\d{1,2})月(?:份)?(?:的)?(?:个人|全店|本店|门店)?(?:业绩|进度|汇总|目标|完成|数据|经营)/.exec(masked);
    if (mOnly) {
      const m = Number(mOnly[1]);
      if (m >= 1 && m <= 12 && m !== curMonth) return true;
    }
  }
  return false;
}

/** 校验模型抽出的 period 槽位是否指向不支持的历史期间。 */
export function isUnsupportedHistoricalPeriodSlot(period: string | undefined, businessDay: string): boolean {
  if (!period?.trim()) return false;
  const flat = flatOf(period);
  if (/上个?月|去年|前年|上季度|上半年|往月|历史/.test(flat)) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) return false;
  const curYm = businessDay.slice(0, 7);
  const curMonth = Number(businessDay.slice(5, 7));
  const ym = /^(20\d{2})[-/年](\d{1,2})月?$/.exec(flat);
  if (ym) {
    const target = `${ym[1]}-${String(Number(ym[2])).padStart(2, '0')}`;
    if (target < curYm) return true;
  }
  const mOnly = /^(\d{1,2})月(?:份)?$/.exec(flat);
  if (mOnly) {
    const m = Number(mOnly[1]);
    if (m >= 1 && m <= 12 && m !== curMonth) return true;
  }
  return false;
}

const NON_COLLEAGUE_SMALL_OLD = /老客户|老顾客|老会员|老客|老板|老化|老店|老带新|小红书|小计|小程序|小单|小额|小票|小组|小时|小样|小项|小项目|小卡|小本|小姐姐|小姐|老师|小费|小包|小瓶|小盒|小支|小份|小图|小视频|小号|小店/g;
const COLLEAGUE_NICK_QUERY_CONTEXT = /(?:查|看|瞧|问|了解|关于|看看|查一下|看一下)(?:一下|下)?((?:小|老)[\u4e00-\u9fa5])|((?:小|老)[\u4e00-\u9fa5])(?=(?:的|今天|今日|本月|这个月|这月|这周|本周|业绩|进度|干了|做了|报了|完成|入账|多少|几单|明细|目标|还差|排名))/g;

/** 仅从业绩查询分句里识别未入花名册的同事昵称（如「小王/老周」），排除老客/小计/小红书等业务词。 */
function unlistedColleagueNicknames(text: string, actor: Person): string[] {
  const tail = compoundTail(text);
  const head = compoundHead(text);
  const scopeText = tail && clauseKind(tail) === 'marketing' && head !== text ? head : text;
  const cleaned = flatOf(scopeText).replace(NON_COLLEAGUE_SMALL_OLD, '　');
  const found = new Set<string>();
  for (const m of cleaned.matchAll(COLLEAGUE_NICK_QUERY_CONTEXT)) {
    const nick = m[1] ?? m[2];
    if (nick && nick !== actor.displayName) found.add(nick);
  }
  return [...found];
}

/** R6：格式明确、在权限内的查询应直接办。覆盖「查一下我今天的进度」「查本店业绩」「看今天的单」等自然说法。 */
export function isSelfProgressQuery(text: string): boolean {
  const flat = flatOf(text);
  if (/^(?:我的进度|今天进度|进度)$/.test(flat)) return true;
  if (hasUnsupportedHistoricalPeriod(flat)) return false;
  if (/金额|元|块|报一笔|记一笔|改成|改账/.test(flat) && /\d/.test(flat)) return false;
  if (/\d/.test(flat)) return false;
  const selfMetric = '(?:个人)?(?:业绩(?:进度)?|进度|已入账|入账结果?|(?:做了|完成了?|报了)(?:多少|几单|什么)?(?:业绩|单|钱)?|完成(?:情况|度|率)?|目标|(?:已完成)?金额|(?:目标|业绩|已完成金额|金额|完成率|进度|差额)(?:[、，,和与及](?:目标|业绩|已完成金额|金额|完成率|进度|差额))+)';
  return new RegExp(`^(?:请?帮?(?:我)?)?(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查|看|问|列)(?:一?下|查|看)?(?:我|本人)(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?${selfMetric}(?:是?(?:多少|怎样|怎么样))?(?:吧|啊|呢|吗)?[?？。！!]*$`).test(flat)
    || new RegExp(`^(?:请)?(?:帮我|给我)(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查|看|问|列)(?:一?下)?(?:的)?(?:今天|今日|本月|这个月|这月)(?:的)?${selfMetric}(?:是?(?:多少|怎样|怎么样))?(?:吧|啊|呢|吗)?[?？。！!]*$`).test(flat)
    || new RegExp(`^(?:我|本人)(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?(?:(?:个人)?(?:业绩(?:进度)?|进度|已入账|完成率|目标|(?:目标|业绩|已完成金额|金额|完成率|进度|差额)(?:[、，,和与及](?:目标|业绩|已完成金额|金额|完成率|进度|差额))+)|离(?:本月|这个月|这月|今天|今日)?目标还差多少|目标(?:还差|差额|完成率)(?:多少)?)(?:是?(?:多少|怎样|怎么样))?(?:吧|啊|呢|吗)?[?？。！!]*$`).test(flat)
    || /^(?:请?帮?(?:我)?)?(?:只(?:想|是|要)?)?(?:查询|查看|查|看|列)(?:一?下)?(?:我|本人)?(?:的)?今天(?:的)?(?:单|报数|入账|已入账|已报)(?:吧|啊|呢|吗)?[?？。！!]*$/.test(flat);
}
export function isStorePerfQuery(text: string): boolean {
  const flat = flatOf(text);
  if (hasUnsupportedHistoricalPeriod(flat)) return false;
  if (/金额|报一笔|记一笔|改成/.test(flat) && /\d/.test(flat)) return false;
  const storeMetric = '(?:业绩(?:汇总|小计)?|汇总|小计|完成|进度|完成率|目标|目标差额|(?:目标|业绩|已完成金额|金额|完成率|进度|差额)(?:[、，,和与及](?:目标|业绩|已完成金额|金额|完成率|进度|差额))+)';
  return new RegExp(`^(?:请?帮?(?:我)?)?(?:只(?:想|是|要)?)?(?:查询|查看|查|看)(?:一?下)?(?:本店|我们店|门店|全店|本店今天|本店本月)(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?(?:全店的?)?${storeMetric}(?:是?(?:多少|怎样|怎么样))?(?:吧|啊|呢|吗)?[?？。！!]*$`).test(flat)
    || new RegExp(`^(?:本店|我们店|全店)(?:今天|今日|本月|这个月|这月)?(?:的)?(?:${storeMetric}|离(?:本月|这个月|这月|今天|今日)?目标还差多少)(?:是?(?:多少))?(?:吧|啊|呢|吗)?[?？。！!]*$`).test(flat)
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
    // Conjunction characters are valid in directory names. Only an exact directory match may resolve this entire field.
    if (!/^[\p{Script=Han}\w.-]{1,120}$/u.test(field)) return null;
    targets.add(field);
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
  if (!QUERY.test(flat) && !STORE_WIDE.test(flat) && !STORE_TOTAL_WORD.test(flat)) return null;
  const namedAll = colleaguesNamed(text, people, actor);
  const named = namedAll.filter(p => p.storeId === actor.storeId);
  const namedOther = namedAll.filter(p => p.storeId !== actor.storeId);
  if (namedOther.length && METRIC.test(flat)) {
    return cannot(`只能办本店（${actor.storeName}）的事，不能查${namedOther.map(p => p.displayName).join('、')}（${[...new Set(namedOther.map(p => p.storeName))].join('、')}）的业绩`);
  }
  if (named.length && METRIC.test(flat) && !await ctx.allowed('progress_other', actor.storeId)) {
    return cannot(`你没有权限查同事（${named.map(p => p.displayName).join('、')}）的业绩，这个需要店长来查；查自己的请发「我的进度」`);
  }
  // 目录未收录的「小X/老X」问法，同样不能查别人（先校验 progress_other 权限，并排除老客/小计/小红书等非人名词）。
  if (!namedAll.length && METRIC.test(flat) && !await ctx.allowed('progress_other', actor.storeId)) {
    const nicks = unlistedColleagueNicknames(text, actor);
    if (nicks.length) return cannot(`你没有权限查同事（${nicks.join('、')}）的业绩，这个需要店长来查；查自己的请发「我的进度」`);
  }
  const personalOrApptTotal = /预约/.test(flat) || /(?:我|本人)(?:名下|今天|今日|明天|明日|后天|本月|这个月|这月|自己|的)/.test(flat);
  const storeWideHit = STORE_WIDE.test(flat) || (STORE_TOTAL_WORD.test(flat) && !personalOrApptTotal);
  if (storeWideHit && !await ctx.allowed('store_summary', actor.storeId) && !await ctx.allowed('stores_ranking', actor.storeId)) {
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
  if (parseAppointmentReadQuery(text) !== null) return false;
  // 只看前半句（复合句后半句里的「昨天那单」是另一件事，由复合句规则处理）。
  const flat = maskNegatedPastDay(flatOf(compoundHead(text)));
  // 纯预约（明天几点来/给我登记一下，没有成交金额）不当「非今天的报数」。
  // 金额须紧跟称谓或带货币单位，避免把「明天15点」或「阿姨…15点」当成成交金额。
  const moneyish = /(?:\d+(?:\.\d+)?\s*(?:元|块钱|块|[kKwW千万])|[一二三四五六七八九十百千万]{2,}\s*(?:元|块)?|(?:姐|哥|姨|叔|女士|先生|阿姨|老师)\s*\d{2,})/;
  // 预约只读查询（含「后天已登记的预约」）绝不当非今天报数。
  if (/预约/.test(flat) && /(?:查|看|几[个条笔]|多少|哪些|什么|数量|条数|个数|列表|记录|结果|查询)/.test(flat) && !moneyish.test(flat)) return false;
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

export interface AppointmentReadSpec {
  scope: 'own' | 'store' | 'other';
  day?: 'today' | 'tomorrow' | 'day_after_tomorrow';
  target?: string;
  countOnly?: boolean;
  /** 显式要求看本店/全店/全体预约（与裸「预约列表」「今天的预约」区分，无 appointment_receive 时明确拒答）。 */
  explicitStoreWide?: boolean;
}

const IDENTITY_ROLE_CLAUSE = /^(?:我|本人)?(?:当前|目前|现在)?(?:实际)?(?:在系统里|在店里|在本店|系统里)?(?:的)?(?:(?:是什么|属于什么)(?:业务身份|身份|岗位|角色|职级)|(?:业务身份|身份|岗位|角色|职级)(?:是什么|是啥))$/;
const IDENTITY_STORE_CLAUSE = /^(?:我|本人)?(?:当前|目前|现在)?(?:实际)?(?:在系统里|在店里|在本店|系统里)?(?:的)?(?:(?:(?:获|被)?授权|有权限|能|可以)(?:访问|查看|管理|看|查)?(?:的)?(?:哪些门店|什么门店|门店(?:有哪些|是什么|是哪些))|(?:获|被)?授权(?:访问|查看|管理)?的?门店(?:是什么|有哪些|是哪些))$/;

export function isIdentityScopeQuery(text: string): boolean {
  const flat = flatOf(text).replace(/[?？。！!;；]+$/g, '');
  const stripped = flat.replace(/^(?:请)?(?:帮我|给我)?(?:只(?:想|是|要)?)?(?:查一下|查询|查看|核对一下|核对|看看|查|看)/, '');
  if (/^(?:我|本人)(?:当前|目前|现在)?(?:实际)?(?:在系统里|在店里|在本店|系统里)?(?:的)?(?:(?:是什么|属于什么)(?:业务身份|身份|岗位|角色|职级)|(?:业务身份|身份|岗位|角色|职级)(?:是什么|是啥))(?:(?:和|以及|还有|并|并且)?(?:我|本人)?(?:当前|目前|现在)?(?:实际)?(?:(?:获|被)?授权(?:访问|查看|管理)?(?:的)?(?:哪些门店|什么门店|门店(?:是什么|有哪些|是哪些))))?$/.test(stripped)) {
    return true;
  }
  if (/^(?:我|本人)(?:当前|目前|现在)?(?:实际)?(?:业务身份和)?(?:的)?(?:(?:(?:获|被)?授权|有权限|能|可以)(?:访问|查看|管理|看|查)?(?:的)?(?:哪些门店|什么门店|门店(?:有哪些|是什么|是哪些))|(?:获|被)?授权门店(?:是什么|有哪些|是哪些))$/.test(stripped)) {
    return true;
  }
  const parts = stripped
    .split(/[?？，,；;。、]+/)
    .map(part => part.replace(/^(?:以及|还有|并且|并|和)/, '').trim())
    .filter(Boolean);
  if (parts.length === 2 && /(?:我|本人)/.test(stripped)) {
    const [a, b] = parts as [string, string];
    return (IDENTITY_ROLE_CLAUSE.test(a) && IDENTITY_STORE_CLAUSE.test(b))
      || (IDENTITY_STORE_CLAUSE.test(a) && IDENTITY_ROLE_CLAUSE.test(b));
  }
  return false;
}

export function parseAppointmentReadQuery(text: string): AppointmentReadSpec | null {
  const rawFlat = flatOf(text);
  if (!rawFlat.includes('预约')) return null;
  if (/\d{1,2}[:：点时号日月]|\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(rawFlat)) return null;
  const guardAtom = '(?:我)?(?:先|暂)?(?:(?:刚才|刚刚|之前|上一?笔?)?(?:那笔|这笔|当前)?(?:待确认|未确认)?(?:的)?(?:草稿|报单|单子?)?(?:先放着|放着|先不管|先不处理|暂不处理|先别管|先别动|先不确认|先别确认|放一放)|不是(?:来|要)?(?:登记|新建|新)?(?:预约|报单|报数|报业绩)|(?:不(?:要|用|想)?|别)(?:再)?(?:帮我|给我)?(?:新建|新)?(?:登记(?:或|和|及|、)?改单|登记|改单|预约|报单|报数|报业绩|改账)(?:也?(?:不(?:要|用)?|别)(?:登记|改单|预约|报单|改账))?|只(?:问|看|要|查)(?:数量|条数|个数|预约)|不(?:要|用)?(?:列|看)?明细|直接告诉我)';
  const guardClauseRe = new RegExp(`^(?:${guardAtom})(?:[、，,；;\\s]*(?:${guardAtom}))*[。.!！?？]*$`);
  const normalized = text.normalize('NFKC').trim().replace(/^只读(?:查询|核对)\s*:?\s*/, '');
  // 若按标点切分后，除目标预约子句外其余全为前置/后置保留状态约束（如「刚才那笔待确认的先放着，我只查自己今天有几条预约」「不用登记或改单，只问未来有几条预约」），仅解析预约子句本身。
  let candidateText = normalized;
  const clauses = normalized.split(/[，,。；;！!？?\n]+/).map(s => s.trim()).filter(Boolean);
  if (clauses.length > 1) {
    const apptClauses = clauses.filter(c => flatOf(c).includes('预约'));
    const otherClauses = clauses.filter(c => !flatOf(c).includes('预约'));
    if (apptClauses.length === 1 && otherClauses.every(c => guardClauseRe.test(flatOf(c)))) {
      candidateText = apptClauses[0]!;
    }
  }
  const cleaned = candidateText
    .replace(new RegExp(`^${guardAtom}(?:[、，,；;\\s]+${guardAtom})*[，,。；;？?\\s]+(?=\\S)`), '')
    .replace(new RegExp(`[?？。;；，,\\s]+${guardAtom}(?:[、，,；;\\s]+${guardAtom})*[。.!！?？]*$`), '');
  const flat = flatOf(cleaned).replace(/[?？。！!;；]+$/g, '');
  if (!flat.includes('预约')) return null;
  if (/\d{1,2}[:：点时号日月]|\d{2,}/.test(flat)) return null;
  if (/(?:帮我约|帮.{0,4}约|给我约|替.{0,4}约|安排预约|取消|改(?!单)|确认预约|话术|带教|演练|课件)/.test(flat)) return null;
  const day: 'today' | 'tomorrow' | 'day_after_tomorrow' | undefined = /(?<!大)后天/.test(flat)
    ? 'day_after_tomorrow'
    : /明天|明日/.test(flat)
      ? 'tomorrow'
      : (/今天|今日/.test(flat) && !/今天及以后/.test(flat) ? 'today' : undefined);
  const countOnly = /(?:有几[个条笔]|一共几[个条笔]|总共几[个条笔]|共有?几[个条笔]|多少[个条笔]?|几[个条笔]|数量|条数|个数|数一?下|统计|只(?:问|看|要|查)(?:数量|条数|个数))/.test(rawFlat);
  const finish = (base: AppointmentReadSpec): AppointmentReadSpec => ({
    ...base,
    ...(day ? { day } : {}),
    ...(countOnly ? { countOnly: true } : {}),
  });
  if (/^(?:我的预约|本人预约|自己(?:的)?预约|我名下的?预约|预约结果|我登记的预约)$/.test(flat)) return finish({ scope: 'own' });
  if (/^(?:预约列表|(?:今天|今日|明天|明日|后天)的?预约)$/.test(flat)) {
    return finish({ scope: 'store' });
  }
  if (/^(?:(?:本店|全店|门店|店里)(?:的)?(?:全体|全员|全部|所有|大家)?(?:员工|同事|人)?(?:的)?(?:今天|今日|明天|明日|后天|未来|接下来|后续|之后|以后|近期)?(?:的)?预约|(?:全体|全员|全部|所有)(?:员工|同事|人)?(?:今天|今日|明天|明日|后天|未来|接下来|后续|之后|以后|近期)?(?:的)?预约)$/.test(flat)) {
    return finish({ scope: 'store', explicitStoreWide: true });
  }
  const dayToken = '(?:今天|今日|明天|明日|后天|未来|以后|之后|后续|接下来|近期)';
  const regToken = '(?:(?:已(?:经)?)?(?:登记|有|约)的?)?';
  const selfActor = '(?:(?:我|本人)(?:名下|自己)?|自己)';
  const ownQual = new RegExp(`^(?:${selfActor}(?:的)?${dayToken}?(?:的)?${regToken}|${dayToken}${selfActor}(?:的)?${regToken}|(?:未来|以后|之后|后续|接下来|近期)(?:的)?${regToken})$`);
  const storeGroup = '(?:全体|全员|全部|所有|大家)(?:员工|同事|人)?';
  const storeQual = new RegExp(`^(?:(?:本店|全店|门店|店里)(?:的)?(?:${storeGroup}(?:的)?)?${dayToken}?(?:的)?${regToken}|(?:本店|全店|门店|店里)(?:的)?${dayToken}(?:的)?(?:${storeGroup}(?:的)?)?${regToken}|${storeGroup}(?:的)?${dayToken}?(?:的)?${regToken}|${dayToken}(?:的)?${storeGroup}(?:的)?${regToken})$`);
  const bareDayQual = new RegExp(`^${dayToken}(?:的)?${regToken}$`);
  const cleanTarget = (qual: string) =>
    qual.replace(new RegExp(`${dayToken}?(?:的)?${regToken}$`), '').replace(/的$/, '') || qual;
  const looksLikeEntityTarget = (target: string): boolean => {
    if (!target) return false;
    if (/(?:放着|待确认|草稿|刚才|刚刚|先不|先别|不用|不要|不改单|不是|只查|只问|只能)/.test(target)) return false;
    if (otherStoreShortNames(target, '').length > 0) return true;
    if (/店$/.test(target) && target.length <= 20) return true;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{1,32}$/.test(target)) return true;
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(target)) return true;
    return false;
  };
  const resolveQual = (qual: string, defaultScope: 'own' | 'store'): AppointmentReadSpec | null => {
    if (!qual) return finish({ scope: defaultScope });
    if (ownQual.test(qual)) return finish({ scope: 'own' });
    if (storeQual.test(qual)) return finish({ scope: 'store', explicitStoreWide: true });
    if (bareDayQual.test(qual)) return finish({ scope: defaultScope });
    const target = cleanTarget(qual);
    if (!looksLikeEntityTarget(target)) return null;
    return finish({ scope: 'other', target });
  };
  const matchClause = (body: string, allowBareSuffix: boolean): { qual: string } | null => {
    const pre = /^(.*?)(?:一共|总共|共)?(?:有没有|有哪些|有什么|是哪些|有几[个条笔]|多少[个条笔]?|几[个条笔])(?:已(?:经)?(?:登记|有|约)的?)?预约(?:记录|列表|结果|明细)?$/u.exec(body);
    if (pre) return { qual: pre[1]! };
    const suf = allowBareSuffix
      ? /^(.*)预约(?:记录|列表|结果|明细)?(?:的)?(?:(?:一共|总共|共)?(?:(?:数量|条数|个数)(?:是多少|多少)?|(?:有没有|有哪些|有什么|是哪些|有几[个条笔]|多少[个条笔]?|几[个条笔])))?$/u.exec(body)
      : /^(.*)预约(?:记录|列表|结果|明细)?(?:的)?(?:(?:一共|总共|共)?(?:(?:数量|条数|个数)(?:是多少|多少)?|(?:有没有|有哪些|有什么|是哪些|有几[个条笔]|多少[个条笔]?|几[个条笔])))$/u.exec(body);
    if (suf) return { qual: suf[1]! };
    return null;
  };
  const prefixed = /^(?:请)?(?:(?:我|本人)(?:自己)?)?(?:帮我|给我)?(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查一下|看一下|看下|查|看|问|问一下|问下|列一下|列出|数一下|数下|统计)(?:一?下)?(.+)$/u.exec(flat);
  if (prefixed) {
    const hit = matchClause(prefixed[1]!, true);
    if (!hit) return null;
    return resolveQual(hit.qual, 'own');
  }
  const ask = matchClause(flat, false);
  if (ask) return resolveQual(ask.qual, 'store');
  return null;
}

export function parseSelfAndStoreQuery(request: string): { store?: string } | null {
  const positive = extractScopeConstraints(request).positiveText;
  const flat = flatOf(positive);
  if (/(?:报单|报数|记账|改账|预约|设目标|撤回|确认入账|文案|小红书|朋友圈|海报|话术|复盘)/.test(flat)) return null;
  const hasSelf = /(?:我|本人)(?:自己|个人)?(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?(?:个人)?(?:业绩|进度|已完成金额|完成情况|做了多少|多少)/.test(flat)
    || /(?:我|本人)(?:自己|个人)?(?:和|与|以及|跟|及|、)/.test(flat);
  const storeLead = '(?:和|与|以及|跟|及|、|，|,|；|;|对比)\\s*(?:(?:再|顺便|同时|然后|另外|并|并且|还有)\\s*)?(?:(?:给我|帮我|给|查一下|看一下|看下|查查|看看|查询|查看|列出|列一下|报一下|查|看|列)\\s*)?(?:(?:一下|下)\\s*)?';
  const storeMatch = new RegExp(
    `${storeLead}(?:(?:门店\\s*)?([\\w.-]+(?!店)|(?:(?!店|和|与|及|的|给|查|看|列|再|顺|报)[\\p{Script=Han}A-Za-z0-9]){1,20}店))\\s*的?\\s*(?:今天|今日|本月|这个月|这月)?(?:的)?(?:全店的?)?(?:业绩|汇总|经营汇总|进度|做了多少|多少)`,
    'u',
  ).exec(positive)
    ?? /(本店|全店|我们店|门店)(?:今天|今日|本月|这个月|这月)?(?:的)?(?:全店的?)?(?:业绩|汇总|经营汇总|进度|做了多少|多少)/.exec(flat);
  if (!hasSelf || !storeMatch) return null;
  const rawStore = storeMatch[1]?.trim()
    .replace(/^(?:再|顺便|同时|然后|另外|并|并且|还有)+/, '')
    .replace(/^(?:给我|帮我|给|查一下|看一下|看下|查查|看看|查询|查看|列出|列一下|报一下|查|看|列)+/, '')
    .trim();
  if (!rawStore || /^(?:本店|全店|我们店|门店)$/.test(rawStore)) return {};
  return { store: rawStore };
}

/** A complete read-only question. Discard only framing and explicit negative clauses. */
export type BusinessRead =
  | { kind: 'self' | 'identity' | 'unsupported' | 'historical' }
  | { kind: 'summary'; store?: string; withTarget?: boolean }
  | { kind: 'self_and_summary'; store?: string }
  | { kind: 'managed' | 'existing'; command: string };

export function businessRead(text: string, businessDay?: string): BusinessRead | undefined {
  const request = text.normalize('NFKC').trim()
    .replace(/^[A-Za-z]+-[A-Za-z]*\d+\s*:\s*/, '')
    .replace(/^我(?:现在)?自称[^。！？!?\n]+[。！？!?]\s*/, '')
    .replace(/^只读(?:查询|核对)\s*:?\s*/, '')
    .replace(/^(?:我)?(?:先|暂)?不(?:要|用|想)?(?:报单|报数|创建门店|改权限|扩权|预约|改账|发布|登记|改单)(?:[、，,]\s*(?:我)?(?:先|暂)?不(?:要|用|想)?(?:报单|报数|创建门店|改权限|扩权|预约|改账|发布|登记|改单))*[，,。；;\s]+(?=\S)/, '')
    .replace(/[?？。;；，,]\s*(?:我)?(?:先|暂)?(?:不是补报|不是补录|不(?:要|用|想)?(?:报单|报数|创建门店|改权限|扩权|预约|改账|发布|登记|改单))(?:[、，,]\s*(?:不是补报|不是补录|不(?:要|用|想)?(?:报单|报数|创建门店|改权限|扩权|预约|改账|发布|登记|改单)))*[。.!！]?$/, '')
    .replace(/[?？。;；]+$/, '').trim();
  if (isIdentityScopeQuery(request)) return { kind: 'identity' };
  const flatReq = flatOf(request);
  if (hasUnsupportedHistoricalPeriod(request, businessDay)
      && !/\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flatReq)
      && /(?:业绩|进度|汇总|完成率|目标|经营)/.test(flatReq)
      && !/(?:报单|报数|记账|改账|预约|设目标|定目标|改目标|撤回|确认入账|文案|小红书|朋友圈|海报)/.test(flatReq)) {
    return { kind: 'historical' };
  }
  const selfAndStore = parseSelfAndStoreQuery(request);
  if (selfAndStore) return { kind: 'self_and_summary', ...(selfAndStore.store ? { store: selfAndStore.store } : {}) };
  if (isSelfProgressQuery(request) || /^我(?:本月|今天)?的?(?:个人)?(?:业绩(?:进度)?|进度)(?:是多少|多少)?$/.test(request)) return { kind: 'self' };
  const query = request.replace(/^(?:请|帮我|给我)?(?:只(?:想|是|要)?)?(?:查一下|查询|查看|核对|看看|查|看)\s*/, '');
  const withTarget = /目标|完成率|差额|还差/.test(flatReq);
  const named = /^(?:(?:[\p{Script=Han}]{1,12}的)?门店\s*)?([\w.-]+(?!店)|(?:(?!店|和|与|及)[\p{Script=Han}A-Za-z0-9]){1,20}店)\s*的?\s*(?:本月|这个月|这月|今日|今天)?(?:全店的?)?(?:业绩(?:汇总|小计)?|汇总|小计|进度|目标|完成率)(?:是多少|多少)?$/u.exec(query);
  const command = /^(?:经营汇总|门店汇总|本店汇总|本月汇总)(?:\s+([^\s]+))?$/.exec(request);
  if (isStorePerfQuery(request) && !command?.[1]) return { kind: 'summary', ...(withTarget ? { withTarget: true } : {}) };
  if (named) {
    const target = named[1]!;
    return /^(?:本店|全店)$/.test(target)
      ? { kind: 'summary', ...(withTarget ? { withTarget: true } : {}) }
      : { kind: 'summary', store: target, ...(withTarget ? { withTarget: true } : {}) };
  }
  if (otherProgressCommand.test(request) || missingReportsCommand.test(request) || storeRankingCommand.test(request)) return { kind: 'managed', command: request };
  if (command) return command[1] ? { kind: 'summary', store: command[1] } : { kind: 'summary' };
  if (/^(?:(?:我(?:想|要))?(?:看|查|核对)|门店|分店)/.test(request) && /业绩|经营情况/.test(request)
      && !/报单|报数|记账|改账|预约|设目标|撤回|确认入账/.test(request)) {
    const targets = labelledStoreTargets(request);
    if (!targets || targets.length > 1) return { kind: 'unsupported' };
    if (targets[0]) return { kind: 'summary', store: targets[0], ...(withTarget ? { withTarget: true } : {}) };
  }
  if (existingReadCommand(request)) return { kind: 'existing', command: request };
  if (/^(?:[A-Za-z]+-[A-Za-z]*\d+[：:]\s*)?只读(?:查询|核对)/.test(text.trim())) return { kind: 'unsupported' };
  return undefined;
}

/** Read commands whose handlers need the current draft or appointment view. */
export function existingReadCommand(text: string): boolean {
  return /^入账结果(?:\s+\S+)?$/.test(text.trim()) || parseAppointmentReadQuery(text) !== null;
}
