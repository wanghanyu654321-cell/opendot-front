import { createHash } from 'node:crypto';
import type { Appointment } from './performance-store.js';

/**
 * Minimal confirm-then-write appointments.
 * The historical src/appointments module is not in this repository.
 */

export interface AppointmentRequest { customer: string; whenText: string; note: string; }

export function parseAppointmentUtterance(text: string): AppointmentRequest | null {
  const match = text.trim().match(/^预约\s+(\S+)\s+(.+)$/);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const time = /(\d{1,2})[:：](\d{2})/.exec(match[2]);
  if (!time || time.index === undefined) return null;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59) return null;
  const whenText = match[2].slice(0, time.index + time[0].length).trim();
  const note = match[2].slice(time.index + time[0].length).trim();
  if (!whenText) return null;
  return { customer: match[1], whenText, note };
}

export function validateAppointmentFields(value: unknown): { ok: true; item: AppointmentRequest } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['customer', 'whenText', 'note'].includes(key))) return { ok: false };
  if (typeof body.customer !== 'string' || !body.customer.trim()) return { ok: false };
  if (typeof body.whenText !== 'string' || !/(\d{1,2})[:：](\d{2})/.test(body.whenText)) return { ok: false };
  if (body.note !== undefined && typeof body.note !== 'string') return { ok: false };
  return { ok: true, item: { customer: body.customer.trim(), whenText: body.whenText.trim(), note: typeof body.note === 'string' ? body.note.trim() : '' } };
}

export function stagePendingAppointment(input: AppointmentRequest & {
  appointmentId: string; storeId: string; employeePersonId: string; createdAt: string;
}): Appointment {
  return {
    appointmentId: input.appointmentId,
    storeId: input.storeId,
    employeePersonId: input.employeePersonId,
    customerName: input.customer,
    whenText: input.whenText,
    note: input.note,
    status: 'pending_manager',
    createdAt: input.createdAt,
  };
}

export function confirmAppointment(appointment: Appointment): Appointment {
  if (appointment.status !== 'pending_manager') throw Error('appointment_not_pending');
  return { ...appointment, status: 'confirmed' };
}

/* ───────────────────────── M05：自然语言预约（登记即成立） ───────────────────────── */

/** M05 预约条目：日期/时间已解析成门店时区的墙上时间；whenText = `YYYY-MM-DD HH:MM`。 */
export interface AppointmentItem { customer: string; whenText: string; note: string; date: string; time: string; customerNamed: boolean }
export type AppointmentParse =
  | { kind: 'request'; item: AppointmentItem }
  | { kind: 'needs_time' }
  | { kind: 'ask_confirm_today'; customer: string }
  | { kind: 'past'; date: string; time: string }
  | { kind: 'invalid' };

/** D129：无时间无项目的「今天+称呼+来店」陈述，先问要不要记成今天的预约。 */
export function askConfirmTodayReply(customer: string): string {
  const who = customer.trim() || '这位客人';
  return `Front Claw：要记成${who}今天的预约吗？大概几点？没有写入任何账目。`;
}

export const UNNAMED_CUSTOMER = '未留名';
const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 一…二十九、两、阿拉伯数字。 */
function cnNumber(raw: string): number | null {
  if (/^\d{1,2}$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  const m = /^([一二两三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(raw);
  if (m) return (m[1] ? CN_DIGIT[m[1]]! : 1) * 10 + (m[2] ? CN_DIGIT[m[2]]! : 0);
  if (raw.length === 1 && raw in CN_DIGIT) return CN_DIGIT[raw]!;
  return null;
}
const NUM = '[一二两三四五六七八九]?十[一二三四五六七八九]?|[零〇一二两三四五六七八九]|\\d{1,2}';
const MARKETING_HINT = /文案|小红书|朋友圈|海报|种草|推广|营销|宣传|标语|口号|推文|公众号|抖音|短视频|脚本|广告/;
const GUEST = /客人|顾客|客户|有客|到店|来店|预约|约了|约一下|约个|帮我约|帮.{0,4}约|登记|给我登/;
const NAMED = /([\u4e00-\u9fa5])(先生|女士|小姐|阿姨|老师|姐|哥|叔|总)/g;
const NOT_SURNAME = /[有个位的约点是给和跟来去要请半刻号日月天午晚早上下今后期拜客]/;
const DATE_WORD = /大后天|后天|明天|明日|明儿|今天|今日|今晚|今早|(?:下下?|这|本)?(?:周|星期|礼拜)[一二三四五六日天1-7]|\d{1,2}月\d{1,2}[日号]|\d{1,2}[日号]/;
const TIME_RE = new RegExp(`(\\d{1,2})[:：](\\d{2})|(${NUM})点(?:(半)|(一刻)|(三刻)|(${NUM})分?)?`);

const DAYPART = /上午|早上|早晨|清早|中午|下午|午后|傍晚|晚上|夜里/;
const STANDALONE_TIME = new RegExp(`^(?:${DAYPART.source})?(?:${TIME_RE.source})$`);

/** 确认整句是钟点答复，保留时段供预约解析使用。 */
export function parseStandaloneAppointmentTime(text: string): string | null {
  const clock = text.normalize('NFKC').replace(/\s+/g, '');
  return STANDALONE_TIME.test(clock) && resolveTime(clock, true) ? clock : null;
}

/** 不能当客户名的动词、时间词、项目词。没有明确称呼时不要拿这些来填名字。 */
const NOT_A_CUSTOMER_NAME = /^(?:过来|到店|来店|来做|来看|来了|到了|开始|登记|预约|再来|先来|会来|要来|有人|客人|顾客|客户|明天|后天|今天|今日|明日|上午|下午|晚上|中午|早上|今晚|今早|护理|剪发|做头|项目|套餐|半点|一刻|过来做|到店做|来护理|来剪|来按摩|过去|先到)$/;
const TIME_OR_VERB_CHARS = /^[来到去做过给帮请要会想点分半刻时早晚上下午]+$/;

function acceptableCustomerName(name: string): boolean {
  const n = name.normalize('NFKC').trim();
  if (!n || n.length < 2) return false;
  if (NOT_A_CUSTOMER_NAME.test(n)) return false;
  if (TIME_OR_VERB_CHARS.test(n)) return false;
  if (DATE_WORD.test(n)) return false;
  return true;
}

function customerOf(flat: string): { name: string; named: boolean } {
  for (const m of flat.matchAll(NAMED)) {
    const name = `${m[1]}${m[2]}`;
    if (!NOT_SURNAME.test(m[1]!) && acceptableCustomerName(name)) return { name, named: true };
  }
  const plain = /(?:客人|顾客|客户)([\u4e00-\u9fa5]{2,3}?)(?=要来|会来|过来|来|到店)/.exec(flat);
  if (plain && !/^(?:要|会|说|都|也|们)/.test(plain[1]!) && acceptableCustomerName(plain[1]!)) {
    return { name: plain[1]!, named: true };
  }
  // R2：时间后紧跟的全名（常见单字姓 + 1–2 字名，如「预约明天下午3点张三」）也算点名客人。
  // 动词或时间词（过来、开始、来做）不当名字。
  const full = new RegExp(`(?:点|分|半|刻|\\d{2})(${COMMON_SURNAME.source}[\\u4e00-\\u9fa5]{1,2})$`).exec(flat);
  if (full && acceptableCustomerName(full[1]!)) return { name: full[1]!, named: true };
  return { name: UNNAMED_CUSTOMER, named: false };
}
const COMMON_SURNAME = /[王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤]/;

/** R8（D127）：只认标准预约格式——明确「预约/约了/帮我约」等说法，可带时间。
 * 「今天+客人」类问句没有预约动词则不当预约，交给模型分类。 */
/** 明确的预约动词。仅「今天+客人」没有钟点、没有这类动词时不当预约（D127）。 */
const NEGATED_BOOKING = /(?:不(?:要|用|想|需要)?|别)(?:再)?(?:(?:帮|给|为|替)[\p{Script=Han}]{1,8}?)?(?:安排|登记)?(?:预约|约(?:一下|个|了)?)/u;
const APPOINTMENT_CREATE_VERB = /帮我约|帮.{0,4}约|给我约|替.{0,4}约|安排预约/;
const APPOINTMENT_READ_QUERY =
  /^(?:请)?(?:帮我|给我)?(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查一下|看一下|看下|查|看|列一下|列出).{0,20}预约|预约.{0,6}(?:有哪些|有什么|是哪些|有几[个条笔])|(?:有哪些|有什么|是哪些).{0,6}预约|已(?:经)?(?:登记|有|约)的?预约|预约(?:记录|列表|结果|明细)/;
const APPOINTMENT_CUE = /预约|约了|约一下|约个|帮我约|帮.{0,4}约|给我约|登记预约/;
const APPOINTMENT_COACHING = /预约\s*(?:(?:客户|顾客|客人)\s*)?(?:(?:接待|沟通|流程|登记|咨询)\s*)?(?:话术|带教|演练|课件)/g;
export const withoutAppointmentCoaching = (text: string): string => text.replace(APPOINTMENT_COACHING, '');

function positiveAppointmentText(text: string): string {
  if (!NEGATED_BOOKING.test(text)) return text;
  return text.split(/[，,。;；、！？!?]/).filter(clause => !NEGATED_BOOKING.test(clause)).join('，');
}
export function onlyNegatedAppointment(text: string): boolean {
  return NEGATED_BOOKING.test(text) && !positiveAppointmentText(text).trim();
}

export function looksLikeAppointment(text: string): boolean {
  const raw = typeof text === 'string' ? positiveAppointmentText(withoutAppointmentCoaching(text)).trim() : '';
  const flat = raw.replace(/\s+/g, '');
  if (!flat || flat.length > 200 || MARKETING_HINT.test(flat)) return false;
  if (parseAppointmentUtterance(raw)) return true;
  if (APPOINTMENT_READ_QUERY.test(flat) && !APPOINTMENT_CREATE_VERB.test(flat)) return false;
  const named = [...flat.matchAll(NAMED)].some(m => !NOT_SURNAME.test(m[1]!)) && /来|约|到/.test(flat);
  if (!GUEST.test(flat) && !named && !APPOINTMENT_CUE.test(flat)) return false;
  // 有钟点（三点 / 15:00）的来店说法仍是预约（M05 既有路径）。
  if (TIME_RE.test(flat)) return true;
  // 明确说「预约」即使还没说时间：交给解析去问几点（D104）。
  if (APPOINTMENT_CUE.test(flat)) return true;
  // D127：「今天+客人」类问句（来吗、来不来、？）没有钟点、没有预约动词 → 不当预约，交模型。
  // 「明天有客人要来」这类陈述仍走预约、再问几点（M05）。
  if (/[?？]|吗|么$|来不来|来了没|是不是|有没有/.test(flat)) return false;
  if (DATE_WORD.test(flat) && (GUEST.test(flat) || named)) return true;
  return false;
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}
function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function zonedToday(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/** 日期：日历日（门店时区），不按营业日切点。返回 null 表示日期写法无效。 */
function resolveDate(flat: string, today: string): string | null {
  if (/大后天/.test(flat)) return shiftDate(today, 3);
  if (/后天/.test(flat)) return shiftDate(today, 2);
  if (/明天|明日|明儿/.test(flat)) return shiftDate(today, 1);
  if (/今天|今日|今晚|今早/.test(flat)) return today;
  const week = /(下下?|这|本)?(?:周|星期|礼拜)([一二三四五六日天1-7])/.exec(flat);
  if (week) {
    const raw = week[2]!;
    const target = /[日天7]/.test(raw) ? 7 : (/\d/.test(raw) ? Number(raw) : CN_DIGIT[raw]!);
    const current = weekdayOf(today) || 7; // 周一=1 … 周日=7
    const monday = shiftDate(today, 1 - current);
    if (week[1] === '下') return shiftDate(monday, 7 + target - 1);
    if (week[1] === '下下') return shiftDate(monday, 14 + target - 1);
    // 「周五」不带前缀：本周该日；已过则下周该日。「这周/本周」只取本周。
    const inWeek = shiftDate(monday, target - 1);
    if (week[1]) return inWeek;
    return inWeek < today ? shiftDate(inWeek, 7) : inWeek;
  }
  const [y, m] = today.split('-').map(Number);
  const md = /(\d{1,2})月(\d{1,2})[日号]/.exec(flat);
  if (md) {
    const month = Number(md[1]), day = Number(md[2]);
    // 12 月说 1–2 月 → 明年；其余按今年（早于今天由调用方判为已过）。
    const year = m === 12 && month <= 2 ? y! + 1 : y!;
    return validYmd(year, month, day) ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  }
  const dOnly = /(\d{1,2})[日号]/.exec(flat);
  if (dOnly) {
    const day = Number(dOnly[1]);
    let year = y!, month = m!;
    if (`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` < today) { month += 1; if (month > 12) { month = 1; year += 1; } }
    return validYmd(year, month, day) ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  }
  return today;
}

/** 时间：不带上下午时 1–7 点按下午（门店营业时段，默认值待拍板）；中午 1–5 点按下午；返回 HH:MM 或 null。 */
function resolveTime(flat: string, standalone = false): string | null | undefined {
  const t = TIME_RE.exec(flat);
  if (!t) return undefined;
  let hour: number, minute: number;
  if (t[1] !== undefined) { hour = Number(t[1]); minute = Number(t[2]); }
  else {
    const h = cnNumber(t[3]!); if (h === null) return null;
    hour = h;
    minute = t[4] ? 30 : t[5] ? 15 : t[6] ? 45 : t[7] ? (cnNumber(t[7]) ?? -1) : 0;
  }
  const before = flat.slice(0, t.index);
  const pm = /下午|午后|傍晚|晚上|今晚|夜里|晚/.test(before), am = /上午|早上|早晨|清早|今早|早/.test(before), noon = /中午/.test(before);
  if (pm && hour < 12) hour += 12;
  else if (noon && hour < 6) hour += 12;
  else if (!pm && !am && !noon && !(standalone && t[1] !== undefined) && hour >= 1 && hour <= 7) hour += 12;
  if (hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * M05：解析一句预约。先沿用旧格式「预约 名字 HH:MM 备注」（parseAppointmentUtterance），否则按自然语言。
 * 空格不影响结果；没有时间 → needs_time；时间已过 → past；日期/时间写法无效 → invalid；不像预约 → null。
 */
export function parseAppointmentRequest(text: string, now: Date, timeZone: string, timeFollowup?: {
  clock: string; originalText: string; requestedAt: Date;
}): AppointmentParse | null {
  const raw = typeof text === 'string' && text.length <= 200 ? positiveAppointmentText(text).trim() : '';
  if (!raw || raw.length > 200) return null;
  const legacy = parseAppointmentUtterance(raw);
  const flat = raw.replace(/\s+/g, '');
  const original = timeFollowup?.originalText.replace(/\s+/g, '') ?? flat;
  // D127：没有标准预约说法（也没有旧格式）则不当预约。
  if (!legacy && !looksLikeAppointment(raw)) return null;
  const today = zonedToday(now, timeZone);
  const source = legacy ? legacy.whenText.replace(/\s+/g, '') : flat;
  const date = timeFollowup
    ? resolveDate(original, zonedToday(timeFollowup.requestedAt, timeZone).date)
    : resolveDate(source, today.date);
  const clockReply = timeFollowup?.clock;
  // 明确答复的时段或 24 小时制优先。单说「4点」时沿用上轮的时段。
  const time = clockReply && (DAYPART.test(clockReply) || clockReply.includes(':'))
    ? resolveTime(clockReply, true) : resolveTime(source);
  if (time === undefined) {
    // D129：「今天周老师来店」无钟点、无项目、无预约动词 → 先问，不直接记预约。
    // 「明天有客人要来」仍走 needs_time（M05）。
    if (!legacy && !APPOINTMENT_CUE.test(flat) && /今天|今日|今晚|今早/.test(flat) && !/(?:来做|过来做|做个?|做一?下)/.test(flat)) {
      const who = customerOf(flat);
      if (who.named && who.name !== UNNAMED_CUSTOMER && /来|到/.test(flat)) {
        return { kind: 'ask_confirm_today', customer: who.name };
      }
    }
    return { kind: 'needs_time' };
  }
  if (date === null || time === null) return { kind: 'invalid' };
  const [hh, mm] = time.split(':').map(Number);
  if (date < today.date || (date === today.date && hh! * 60 + mm! <= today.minutes)) return { kind: 'past', date, time };
  const explicitName = legacy?.customer ?? (timeFollowup && /^预约\s+(\S+)\s+/.exec(timeFollowup.originalText)?.[1]);
  const who = explicitName && (!timeFollowup || acceptableCustomerName(explicitName))
    ? { name: explicitName, named: true } : customerOf(original);
  const projectText = timeFollowup ? original.replace(/预约$/, '') : original;
  const spokenProject = /(?:来做|过来做|做个?|做一?下)([\u4e00-\u9fa5A-Za-z]{1,8})/.exec(projectText)?.[1];
  let project = legacy && !timeFollowup ? legacy.note : spokenProject ?? '';
  if (timeFollowup && !project && who.named) {
    const remainder = original.replace(who.name, '').replace(DATE_WORD, '').replace(DAYPART, '');
    const namedProject = /^(?:预约([\u4e00-\u9fa5A-Za-z]{1,8})|([\u4e00-\u9fa5A-Za-z]{1,8})预约)$/.exec(remainder);
    project = namedProject?.[1] ?? namedProject?.[2] ?? '';
  }
  return { kind: 'request', item: { customer: who.name, customerNamed: who.named, whenText: `${date} ${time}`, note: project, date, time } };
}

/** 回显用：11月13日（周五）15:00。 */
export function describeWhen(item: { date: string; time: string }): string {
  const [, m, d] = item.date.split('-').map(Number);
  return `${m}月${d}日（周${'日一二三四五六'[weekdayOf(item.date)]}）${item.time}`;
}

/** M05 预约号：按内容确定（门店+登记人+时间+顾客+备注）。同内容重发/并发确认落到同一行（主键去重），不靠姓名金额以外的猜测。 */
export function appointmentContentId(input: { storeId: string; employeePersonId: string; whenText: string; customer: string; note: string }): string {
  return createHash('sha256').update(JSON.stringify(['front-claw-appointment:m05', input.storeId, input.employeePersonId, input.whenText, input.customer, input.note])).digest('hex');
}
/** 预约提醒的通知 ID：预约 + 收件人确定，重放不增。 */
export function appointmentReminderId(appointmentId: string, recipientPersonId: string): string {
  return createHash('sha256').update(JSON.stringify(['front-claw-appointment-reminder:m05', appointmentId, recipientPersonId])).digest('hex');
}
export const shortAppointmentNo = (appointmentId: string) => appointmentId.slice(0, 8);

/** 指定店长配置（PG config）。每店一人；缺省或损坏 → 无收件人（预约照样成立）。 */
export const APPOINTMENT_RECIPIENTS_KEY = 'front-claw-appointment-recipients';
export function designatedRecipient(raw: string | null, storeId: string): string | null {
  try {
    const parsed = JSON.parse(raw ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const stores = (parsed as { stores?: unknown }).stores;
    if (!stores || typeof stores !== 'object' || Array.isArray(stores)) return null;
    const value = (stores as Record<string, unknown>)[storeId];
    return typeof value === 'string' && value.trim() && value.length <= 128 ? value : null;
  } catch { return null; }
}

/** 提醒正文（仅提醒，无需回复）。 */
export function reminderBody(input: { storeName: string; employeeName: string; item: { date: string; time: string; customer: string; note: string }; appointmentId: string }): string {
  return [
    `Front Claw 预约提醒（仅提醒，无需回复）`,
    `${input.storeName}｜${describeWhen(input.item)}`,
    `顾客：${input.item.customer}${input.item.customer === UNNAMED_CUSTOMER ? '（顾客未留名，请留意）' : ''}${input.item.note ? `｜项目：${input.item.note}` : ''}`,
    `登记人：${input.employeeName}｜预约号 ${shortAppointmentNo(input.appointmentId)}`,
  ].join('\n');
}
