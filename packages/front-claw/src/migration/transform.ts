import { decodeStatus, encodeStatus } from '../role-eval/notification-status.js';
import { draftReminderId, draftVoidNoticeId } from '../role-eval/notification-dispatch.js';
import type { CanonicalRow } from './inventory.js';
import { RUNTIME_CONFIG_KEYS, type TableSpec } from './tables.js';

/**
 * M08 转换（D58），每行返回目标行与转换名；null = 不迁移（运行态行）。
 * - 预约 pending_manager → registered（M05 “登记即成立”）；源状态写进台账 source_sha/transform，可追溯。
 * - 通知凡 pending*（含 claimed/sending）→ not_sent，err=migrated_history_suppressed：历史通知不重发；sent/not_sent/unknown 原样。
 * - 草稿：待确认/已作废的报数草稿 reminder/void_notice 由 none → unknown（旧入口维护不再补发提醒/作废通知）。
 * - performance_config 的运行态键（M07 租约）不迁。
 */
export const SUPPRESSED_ERROR = 'migrated_history_suppressed';
export function transformRow(spec: TableSpec, row: CanonicalRow): { row: CanonicalRow; transform: string } | null {
  if (spec.name === 'performance_config' && RUNTIME_CONFIG_KEYS.has(String(row.key))) return null;
  if (spec.name === 'performance_appointments' && row.status === 'pending_manager') {
    return { row: { ...row, status: 'registered' }, transform: 'appointment_pending_manager_to_registered' };
  }
  if (spec.name === 'performance_notifications') {
    const decoded = decodeStatus(String(row.status));
    if (decoded.status === 'pending') {
      const status = encodeStatus('not_sent', { attempts: decoded.delivery.attempts, resends: decoded.delivery.resends, error: SUPPRESSED_ERROR });
      return { row: { ...row, status }, transform: 'notification_pending_suppressed' };
    }
  }
  if (spec.name === 'performance_drafts' && row.kind === 'report' && (row.status === 'pending' || row.status === 'void') && (row.reminder === 'none' || row.void_notice === 'none')) {
    return { row: { ...row, reminder: row.reminder === 'none' ? 'unknown' : row.reminder ?? null, void_notice: row.void_notice === 'none' ? 'unknown' : row.void_notice ?? null }, transform: 'draft_notices_suppressed' };
  }
  return { row, transform: 'copy' };
}

/**
 * M06 派发器按确定性 ID 给员工入口的报数草稿补“提醒/作废通知”（ON CONFLICT DO NOTHING）。迁入的历史草稿若没有这些行，
 * 迁移后第一次派发就会把历史提醒/作废通知补发出去。这里为每个待确认/已作废的报数草稿预先放一行已抑制的通知（同一确定性 ID），
 * 派发器入队时撞主键即不再发。源里已有同 ID 的行则不合成（走上面的通知转换）。
 */
export const SYNTH_BODY = 'Front Claw：迁移时抑制的历史草稿通知（未发送，不补发）。';
export function synthesizedNotices(drafts: readonly CanonicalRow[], existingIds: ReadonlySet<string>): { draft: CanonicalRow; row: CanonicalRow }[] {
  const out: { draft: CanonicalRow; row: CanonicalRow }[] = [];
  const status = encodeStatus('not_sent', { attempts: 0, resends: 0, error: SUPPRESSED_ERROR });
  for (const draft of drafts) {
    if (draft.kind !== 'report' || (draft.status !== 'pending' && draft.status !== 'void')) continue;
    const draftId = String(draft.draft_id);
    const kinds: ['reminder' | 'void', string][] = draft.status === 'pending' ? [['reminder', draftReminderId(draftId)], ['void', draftVoidNoticeId(draftId)]] : [['void', draftVoidNoticeId(draftId)]];
    for (const [kind, id] of kinds) {
      if (existingIds.has(id)) continue;
      out.push({ draft, row: { notification_id: id, kind, recipient_person_id: draft.reporter_person_id ?? null, body: SYNTH_BODY, status, related_id: draftId, created_at: draft.created_at ?? null, sent_at: null } });
    }
  }
  return out;
}
