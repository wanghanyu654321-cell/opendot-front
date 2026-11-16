import type { AmountIssue } from './amounts.js';
import type { UnclearReason } from './report-extract.js';

/** R2：结构化澄清的提问（路由与员工入口共用）。每条都写明“没有写入”。 */
const F = 'Front Claw';
const AMOUNT: Record<AmountIssue, string> = {
  fraction: '金额超过两位小数，不能精确到分',
  zero: '金额是 0',
  negative: '金额是负数（要冲减请用「改账/撤回」）',
  too_large: '金额超出可存储的上限',
  bad: '金额写法看不懂',
};
export function clarifyQuestion(reason: UnclearReason | 'missing_customer', detail?: string): string {
  const tail = '没有写入任何账目。';
  if (reason in AMOUNT) return `${F}：${AMOUNT[reason as AmountIssue]}${detail ? `（「${detail}」）` : ''}，请写成最多两位小数的金额，例如「680」「680.5元」「1.2k」。${tail}`;
  switch (reason) {
    case 'missing_amount': return `${F}：请补上金额（最多两位小数），例如「张姐 680」或「张姐 680.5元」。${tail}`;
    case 'orphan_amount': return `${F}：有金额对不上客人${detail ? `（「${detail}」）` : ''}，请写成「客人 金额（员工）」，一行一笔。${tail}`;
    case 'customer_two_amounts': return `${F}：同一位客人出现了两个金额，请说清记哪个。${tail}`;
    case 'alternatives': return `${F}：这条里有两个候选（「还是/或者」），请确定一个再发。${tail}`;
    case 'unresolved_choice': return `${F}：「其中一笔」指哪一笔？请写明客人和金额或操作号。${tail}`;
    case 'hedged': return `${F}：你说还没定/记不清，请确认后再发，我不替你猜。${tail}`;
    case 'multi_employee': return `${F}：括号里写了多位员工，请写一位（一笔记给一位员工），或拆成多行。${tail}`;
    case 'pronoun_beneficiary': return `${F}：「他/她」是哪位同事？请在金额后用括号写员工名，例如「钱姐 500（小王）」。${tail}`;
    case 'negated_self': return `${F}：这单不是你的，请在金额后用括号写记给哪位同事。${tail}`;
    case 'count_mismatch': return `${F}：说的笔数和列出的笔数对不上，请逐笔列出。${tail}`;
    case 'total_mismatch': return `${F}：合计和各笔之和对不上，请核对后再发。${tail}`;
    case 'beneficiary_conflict': return `${F}：文字说的代报对象和括号里的员工不一致，请确认记给谁。${tail}`;
    case 'vague_amount': return `${F}：金额不确定${detail ? `（「${detail}」）` : ''}，请告诉我准确的金额（最多两位小数），例如「680」或「680.5」，大约数不能直接入账。${tail}`;
    case 'ask_wan': return `${F}：是 ${detail ?? '这个数'} 万吗？请确认后再发。${tail}`;
    case 'negation': return `${F}：这句话里有「${detail ?? '取消或否定'}」这种取消或否定的意思，请确认是否还要报这一笔。${tail}`;
    case 'not_closed': return `${F}：听起来这单没有成交，我没有记。如果实际做成了，请明确写出准确金额再报。${tail}`;
    case 'missing_customer': return `${F}：请问是哪位客人？请补上客人称呼（例如「张姐」）；如果不知道或没留名，回复「没留名」。没有登记任何预约。`;
  }
  return `${F}：请说清楚再发。${tail}`;
}
