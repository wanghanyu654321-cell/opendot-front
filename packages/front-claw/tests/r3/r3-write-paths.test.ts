import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * R3（A-P1-1）静态检查：写路径清单与“统一带 epoch 的写入入口”。
 * ① performance-postgres.ts 里每条写 SQL（INSERT/UPDATE/DELETE）所在的方法都必须登记在 REGISTRY；未登记 = 失败（新增路径必须先归类）。
 *    归类为 consumer_fenced 的方法，方法体必须经过 fencedWrite( 或 fenceClause(（同一事务条件写）。
 * ② 消费者模块（OpenDot 适配器 → 员工入口）不许直接调用 store 的写方法；只能经 consumer-writes.ts，
 *    或带 guard（guardFor → guard.fence）的 commitConfirming*。
 */
type Kind = 'consumer_fenced' | 'consumer_compensation' | 'dispatcher' | 'admin_or_legacy' | 'lease';
export const REGISTRY: Record<string, { kind: Kind; note: string }> = {
  replacePendingReport: { kind: 'consumer_fenced', note: 'R23 D174：fencedWriteIn + 员工行锁 + 原追问 CAS + 作废旧项并保存新项' },
  saveDraft: { kind: 'consumer_fenced', note: '新建/覆盖草稿：fencedWrite（条件锁读租约 + INSERT…SELECT WHERE EXISTS 租约）' },
  transitionPendingDraft: { kind: 'consumer_fenced', note: 'pending→confirming/void/conflict：fencedWrite + UPDATE … AND EXISTS 租约' },
  compareAndSetPendingAsk: { kind: 'consumer_fenced', note: 'R22 追问版本 CAS：fencedWrite + 原值/过期/到达时间条件 UPDATE' },
  setConfig: { kind: 'consumer_fenced', note: '操作记录（回复前后的持久化）：fencedWrite + INSERT…SELECT WHERE EXISTS 租约；不带 fence 的是管理/旧入口调用' },
  commitConfirmingDraft: { kind: 'consumer_fenced', note: '入账：同一事务 guard 快照 + closeConfirming 条件 UPDATE AND EXISTS 租约' },
  commitConfirmingTarget: { kind: 'consumer_fenced', note: '目标：同上' },
  commitConfirmingCorrection: { kind: 'consumer_fenced', note: '改账：同上' },
  commitConfirmingAppointments: { kind: 'consumer_fenced', note: '预约+提醒入队：同上' },
  commitConfirmingStoreTarget: { kind: 'consumer_fenced', note: '门店月目标：同一事务 guard + closeConfirming + store_targets 条件写' },
  saveStoreTarget: { kind: 'admin_or_legacy', note: '门店月目标管理/测试直接写（入口走 commitConfirmingStoreTarget）' },
  closeConfirming: { kind: 'consumer_fenced', note: '上面四个提交共用的条件 UPDATE（fenceClause）' },
  guardAllows: { kind: 'consumer_fenced', note: '入账门拒绝时经 fencedWriteIn 退回 pending：须本消费者仍是当前持有者（owner+epoch+until），否则 0 行' },
  fencedOut: { kind: 'consumer_fenced', note: '关闭被挡时经 revertIfCurrentHolder / fencedWriteIn，比对当前持有者，不打扰新持有者的 confirming' },
  voidConflict: { kind: 'consumer_fenced', note: '提交冲突后经 fencedWrite 标 void：须本消费者仍是当前持有者；失权则不改' },
  revertIfCurrentHolder: { kind: 'consumer_fenced', note: '补偿共用：fencedWriteIn + UPDATE … AND EXISTS 当前持有者租约' },
  fencedWriteIn: { kind: 'consumer_fenced', note: '统一入口的事务内形态：条件锁读当前持有者 + 写 SQL 带 EXISTS' },
  savePerson: { kind: 'admin_or_legacy', note: '人员目录同步/管理工具，不在消费者路径' },
  saveAlias: { kind: 'admin_or_legacy', note: '别名管理' },
  importAlias: { kind: 'admin_or_legacy', note: 'M08 导入' },
  insertEntries: { kind: 'admin_or_legacy', note: '迁移导入/旧入口（开关默认关闭，见 D99）' },
  reviseEntry: { kind: 'admin_or_legacy', note: '旧统一 handler：R3a 起开关默认关闭（legacyEntry / FRONT_CLAW_LEGACY_ENTRY）；打开时告警；OpenDot 装配 employeeLoop 根本不进这条路径；迁移切换后下线（D99）' },
  saveTarget: { kind: 'admin_or_legacy', note: '旧助手工具（开关默认关闭，见 D99）' },
  claimPendingDraft: { kind: 'admin_or_legacy', note: '旧统一 handler（开关默认关闭，见 D99）' },
  confirmPendingAppointment: { kind: 'admin_or_legacy', note: '旧统一 handler（开关默认关闭，见 D99）' },
  claimDraftNotice: { kind: 'admin_or_legacy', note: '旧维护（开关默认关闭，见 D99）' },
  saveAppointment: { kind: 'admin_or_legacy', note: '导入/旧入口（开关默认关闭，见 D99）' },
  insertNotification: { kind: 'admin_or_legacy', note: '旧入口（UUID 行，派发器不碰；开关默认关闭，见 D99）' },
  updateNotificationStatus: { kind: 'admin_or_legacy', note: '旧入口（开关默认关闭，见 D99）' },
  enqueueNotification: { kind: 'dispatcher', note: 'M06 维护入队（确定性 ID，ON CONFLICT DO NOTHING）' },
  claimDueNotifications: { kind: 'dispatcher', note: 'M06 领取：FOR UPDATE SKIP LOCKED，f = f+1 在同一条 UPDATE 里' },
  beginNotificationSend: { kind: 'dispatcher', note: 'M06 发送门：行锁 + 原文 + f 条件 UPDATE' },
  transitionNotification: { kind: 'dispatcher', note: 'M06 结果写回：原文 + f + 阶段 + 到期条件 UPDATE' },
  requeueNotificationWithAudit: { kind: 'dispatcher', note: '人工补发（管理调用）：CAS + 审计同事务' },
  updateConfigLocked: { kind: 'lease', note: '消费租约/策略更新本身（FOR UPDATE）' },
  insertConfigIfAbsent: { kind: 'lease', note: '租约/高水位首写' },
};

/** R4：大小写不敏感；模板字符串折成一行但保留行数，避免方法归属错位。供本文件与 r4 负例测试共用。 */
export function collectWriteSql(source: string): { method: string; line: number; snippet: string }[] {
  const WRITE = /\b((?:INSERT)\s+INTO\b|(?:UPDATE)\s+\$\{relation|(?:UPDATE)\s+front_claw_perf\.|(?:DELETE)\s+FROM\b)/i;
  const flattened = source.replace(/`([^`]*)`/gs, full => {
    const parts = full.split('\n');
    if (parts.length === 1) return full;
    return parts.join(' ') + '\n'.repeat(parts.length - 1);
  });
  const lines = flattened.split('\n');
  const rawLines = source.split('\n');
  let current = '<top>';
  const out: { method: string; line: number; snippet: string }[] = [];
  lines.forEach((line, index) => {
    const raw = rawLines[index] ?? line;
    const m = /^ {4}async (\w+)\(|^ {2}(?:async )?function (\w+)[<(]|^(?:export )?(?:async )?function (\w+)[<(]/.exec(raw);
    if (m) current = (m[1] ?? m[2] ?? m[3])!;
    if (WRITE.test(line)) out.push({ method: current, line: index + 1, snippet: line.trim().slice(0, 200) });
  });
  return out;
}
function writeMethods(file: string): Map<string, number[]> {
  const found = collectWriteSql(readFileSync(file, 'utf8'));
  const out = new Map<string, number[]>();
  for (const row of found) out.set(row.method, [...(out.get(row.method) ?? []), row.line]);
  return out;
}
function body(file: string, name: string): string {
  const text = readFileSync(file, 'utf8');
  const start = text.search(new RegExp(String.raw`(?:^ {4}async ${name}\(|^ {2}(?:async )?function ${name}[<(])`, 'm'));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.search(/^ {4}async \w+\(|^ {2}(?:async )?function \w+[<(]/m);
  return next < 0 ? rest : rest.slice(0, next);
}

it('R3-W1：performance-postgres.ts 的每条写 SQL 都在已登记的方法里；consumer_fenced 方法确实经过 fencedWrite/fenceClause', () => {
  const file = 'src/role-eval/performance-postgres.ts';
  const found = writeMethods(file);
  const unregistered = [...found.keys()].filter(name => !REGISTRY[name] && name !== 'fencedWrite');
  expect(unregistered, `未登记的写路径：${unregistered.map(n => `${n}@${found.get(n)}`).join(', ')}`).toEqual([]);
  for (const [name, entry] of Object.entries(REGISTRY)) {
    if (entry.kind !== 'consumer_fenced') continue;
    const text = body(file, name);
    if (name === 'fencedWrite' || name === 'fencedWriteIn') {
      expect(/leaseMatch\(|FOR SHARE|EXISTS/.test(text), name).toBe(true);
      continue;
    }
    expect(/fencedWrite\(|fencedWriteIn\(|fenceClause\(|closeConfirming\(|revertIfCurrentHolder\(/.test(text), name).toBe(true);
  }
  console.info(JSON.stringify({ writePaths: [...found].map(([name, lines]) => ({ name, lines, kind: REGISTRY[name]?.kind ?? 'entry' })) }));
});

it('R3-W2：消费者模块不直接调用 store 写方法（只能经 consumer-writes 或带 guard 的 commitConfirming*）', () => {
  const store = readFileSync('src/role-eval/performance-store.ts', 'utf8');
  const iface = store.slice(store.indexOf('export interface PerformanceStore {'));
  const methods = [...iface.slice(0, iface.indexOf('\n}\n')).matchAll(/^ {2}(\w+)\(/gm)].map(m => m[1]!);
  const writes = methods.filter(m => !/^(get|list|load|read)/.test(m));
  expect(writes).toContain('saveDraft'); expect(writes).toContain('setConfig');
  const consumers = ['src/role-eval/employee-loop.ts', 'src/opendot/adapter.ts', 'src/role-eval/operation-records.ts'];
  const offenders: string[] = [];
  for (const file of consumers) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\.(\w+)\(/g)) {
        const name = m[1]!;
        if (!writes.includes(name)) continue;
        if (/^commitConfirming/.test(name)) continue; // 下面单独核对 guard
        offenders.push(`${file}:${i + 1} ${name}`);
      }
    });
  }
  // commitConfirming* 的 guard 参数可能换行：逐个确认调用附近有 guardFor(
  const loop = readFileSync('src/role-eval/employee-loop.ts', 'utf8');
  for (const m of loop.matchAll(/store\.(commitConfirming\w+)\(/g)) {
    expect(/guard/.test(loop.slice(m.index!, m.index! + 400)), m[1]).toBe(true);
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
  // 员工入口用到的助手工具只读。
  expect([...new Set([...loop.matchAll(/tools\.(\w+)\(/g)].map(m => m[1]))]).toEqual(['myProgress']);
});
