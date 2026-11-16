import { PERFORMANCE_SCHEMA } from '../role-eval/performance-migration.js';

/** M08：迁移/对账用的 007 规范列（顺序固定）。只比较 007 列，所以 v7 与 v8 库可直接比对。 */
export interface TableSpec { name: string; key: readonly string[]; columns: readonly string[] }
export const TABLES: readonly TableSpec[] = [
  { name: 'performance_people', key: ['person_id'], columns: ['person_id', 'account_id', 'member_id', 'display_name', 'store_id', 'store_name', 'tier', 'roles_json', 'active'] },
  { name: 'performance_aliases', key: ['store_id', 'alias'], columns: ['store_id', 'alias', 'person_id'] },
  { name: 'wecom_bot_bindings', key: ['bot_id', 'member_id'], columns: ['bot_id', 'member_id', 'corp_id', 'account_id', 'version', 'active'] },
  { name: 'performance_config', key: ['key'], columns: ['key', 'value'] },
  { name: 'performance_targets', key: ['store_id', 'person_id', 'period_month'], columns: ['store_id', 'person_id', 'period_month', 'amount', 'updated_by', 'updated_at'] },
  { name: 'performance_entries', key: ['entry_id'], columns: ['entry_id', 'store_id', 'business_day', 'customer_name', 'amount', 'amount_type', 'owner_person_id', 'owner_name', 'reporter_person_id', 'note', 'status', 'disputed', 'created_at'] },
  { name: 'performance_revisions', key: ['revision_id'], columns: ['revision_id', 'entry_id', 'editor_person_id', 'before_json', 'after_json', 'reason', 'created_at'] },
  { name: 'performance_drafts', key: ['draft_id'], columns: ['draft_id', 'reporter_person_id', 'store_id', 'business_day', 'expires_at', 'kind', 'payload_json', 'status', 'reminder', 'void_notice', 'created_at', 'closed_at'] },
  { name: 'performance_appointments', key: ['appointment_id'], columns: ['appointment_id', 'store_id', 'employee_person_id', 'customer_name', 'when_text', 'note', 'status', 'created_at'] },
  { name: 'performance_notifications', key: ['notification_id'], columns: ['notification_id', 'kind', 'recipient_person_id', 'body', 'status', 'related_id', 'created_at', 'sent_at'] },
];
export const relation = (table: string) => `${PERFORMANCE_SCHEMA}.${table}`;
/** 运行态行：不迁移、不导出（M07 单消费者租约）。 */
export const RUNTIME_CONFIG_KEYS: ReadonlySet<string> = new Set(['front-claw-opendot-consumer']);
