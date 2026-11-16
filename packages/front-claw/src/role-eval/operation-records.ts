import type { PerformanceStore } from './performance-store.js';
import type { BotSendOutcome } from './wecom-bot-sender.js';
import type { ConsumerWrites } from './consumer-writes.js';

/**
 * R1（M07-03）：OpenDot 适配器的操作记录持久化（PG config 一行一条，跨重启可查）。
 * 只记操作元数据（状态、企微消息号、业务操作号、是否入账、回复状态），不碰账本/草稿/通知。
 * 进程在途中退出 → 记录停在 running → 重启后报告为 interrupted。保留策略见 R1 REPORT §0（暂不清理）。
 */
export const OPERATION_RECORD_PREFIX = 'front-claw-op:';
export type OperationRecordState = 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';
export interface OperationRecord {
  state: OperationRecordState; messageId: string; businessOperationId?: string; ledgerSettled: boolean;
  replyState?: BotSendOutcome['state'];
}
const STATES: readonly OperationRecordState[] = ['running', 'completed', 'failed', 'timeout', 'cancelled', 'interrupted'];

export function parseOperationRecord(raw: string | null): OperationRecord | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<OperationRecord>;
    if (!v || typeof v !== 'object' || Array.isArray(v) || !STATES.includes(v.state as OperationRecordState) || typeof v.messageId !== 'string' || typeof v.ledgerSettled !== 'boolean') return null;
    if (v.businessOperationId !== undefined && typeof v.businessOperationId !== 'string') return null;
    if (v.replyState !== undefined && typeof v.replyState !== 'string') return null;
    return v as OperationRecord;
  } catch { return null; }
}
/** R3（A-P1-1）：经消费者统一写入入口（带 M07 epoch）；租约已被接管 → FencedWriteRejected，不覆盖新持有者的记录。 */
export async function saveOperationRecord(writes: Pick<ConsumerWrites, 'putOperationRecord'>, operationId: string, record: OperationRecord): Promise<void> {
  await writes.putOperationRecord(OPERATION_RECORD_PREFIX + operationId, JSON.stringify(record));
}
export async function loadOperationRecord(store: PerformanceStore, operationId: string): Promise<OperationRecord | null> {
  return parseOperationRecord(await store.getConfig(OPERATION_RECORD_PREFIX + operationId));
}
