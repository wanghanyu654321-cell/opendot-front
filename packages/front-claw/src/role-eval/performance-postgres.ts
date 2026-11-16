import { snapshotBinding, type WecomBotBinding } from './wecom-bot-bindings.js';
import { sequenceBefore } from './pending-order.js';
import type {
  AliasRecord, Appointment, CommitGuard, Draft, DraftPayload, EntryFilter, EntryPatch, GateSnapshot, LedgerCommit, LedgerEntry,
  Notification, PerformanceStore, Person, Revision, RevisionMeta, SendSnapshot, StoreTarget, Target, WriteFence,
} from './performance-store.js';
import { claimTransition, clone, entryVersion, settledReportDraft, CommitContentionRejected, FencedWriteRejected, guardKeys, guardPasses, withDelivery } from './performance-store.js';
import { assertStatus, decodeStatus, MAX_FENCE, resultFenceHolds } from './notification-status.js';
import { assertWritableConfigKey, configLockOrder } from './protected-config.js';

/** M04：事务内发现对象已变，用于整体回滚。 */
class CommitConflict extends Error { constructor() { super('commit_conflict'); } }
/** R1：补发审计键已存在 → 回滚状态改写。 */
class AuditExists extends Error { constructor() { super('audit_exists'); } }
import type { WorkbenchRole } from './workbench-access.js';
import { PERFORMANCE_MIGRATION_SQL, PERFORMANCE_SCHEMA } from './performance-migration.js';
import { SCHEMA_LOCK } from './schema-migrations.js';
import { fromPgNumeric, toPgNumeric } from './money.js';
import { PERF_TYPE_CONSULTANT } from './perf-rules.js';

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  /** One connection. A thrown error rolls the statements back. */
  transaction<T>(work: (query: SqlClient['query']) => Promise<T>): Promise<T>;
}

const relation = (name: string) => `${PERFORMANCE_SCHEMA}.${name}`;

export function migrationStatements(sql: string): string[] {
  return sql.replace(/--[^\n]*/g, '').split(';').map(statement => statement.trim()).filter(statement => statement.length > 0);
}

/**
 * 启动时的 007 基线（幂等 CREATE IF NOT EXISTS）。M08：整体放进一个事务并先拿 schema 迁移的 advisory lock，
 * 与其他实例的启动、以及 008 up/down 串行（修复并发首次建表撞 23505）。008 不在这里执行。
 */
export async function migratePerformance(client: SqlClient, sql = PERFORMANCE_MIGRATION_SQL): Promise<void> {
  const statements = migrationStatements(sql);
  for (const statement of statements) {
    const compact = statement.replace(/\s+/g, ' ').trim();
    if (/^(drop|alter)\b/i.test(compact)) throw Error('migration_not_additive');
    const createsSchema = new RegExp(`^CREATE SCHEMA IF NOT EXISTS ${PERFORMANCE_SCHEMA}$`, 'i').test(compact);
    if (!createsSchema && !compact.includes(`${PERFORMANCE_SCHEMA}.`)) throw Error('migration_schema');
  }
  await client.transaction(async query => {
    await query('SELECT pg_advisory_xact_lock($1, $2)', [...SCHEMA_LOCK]);
    for (const statement of statements) await query(statement);
    // 旧合成宿主只装配 007；保留其加法启动兼容。文件凭据路径不执行此 DDL，生产由 011 显式安装。
    await query(`CREATE SEQUENCE IF NOT EXISTS ${PERFORMANCE_SCHEMA}.pending_order_seq AS bigint NO CYCLE CACHE 1`);
  });
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('postgres_row');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw Error('postgres_row');
}
function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw Error('postgres_row');
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function personFrom(row: Row): Person {
  const roles = JSON.parse(text(row.roles_json)) as WorkbenchRole[];
  return {
    personId: text(row.person_id),
    accountId: text(row.account_id),
    memberId: text(row.member_id),
    displayName: text(row.display_name),
    storeId: text(row.store_id),
    storeName: text(row.store_name),
    tier: text(row.tier) as Person['tier'],
    roles,
    active: bool(row.active),
  };
}

async function hasSourceDraftColumns(query: SqlClient['query']): Promise<boolean> {
  try {
    const found = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='performance_entries' AND column_name='source_draft_id'`,
      [PERFORMANCE_SCHEMA]);
    return found.rows.length > 0;
  } catch {
    // MemorySql 没有 information_schema：行是动态列，视为支持。
    return true;
  }
}

function entryFrom(row: Row): LedgerEntry {
  return {
    entryId: text(row.entry_id),
    storeId: text(row.store_id),
    businessDay: text(row.business_day),
    customerName: nullableText(row.customer_name),
    amount: fromPgNumeric(row.amount),
    amountType: text(row.amount_type) === '业绩' ? PERF_TYPE_CONSULTANT : text(row.amount_type) as LedgerEntry['amountType'],
    ownerPersonId: text(row.owner_person_id),
    ownerName: text(row.owner_name),
    reporterPersonId: text(row.reporter_person_id),
    note: text(row.note),
    status: text(row.status) as LedgerEntry['status'],
    disputed: bool(row.disputed),
    createdAt: text(row.created_at),
    ...(row.source_draft_id != null && String(row.source_draft_id) !== ''
      ? { sourceDraftId: text(row.source_draft_id), sourceOrdinal: Number(row.source_ordinal ?? 0) }
      : {}),
  };
}

function definedPatch(patch: EntryPatch): EntryPatch {
  const next: EntryPatch = {};
  if (patch.customerName !== undefined) next.customerName = patch.customerName;
  if (patch.amount !== undefined) next.amount = patch.amount;
  if (patch.ownerPersonId !== undefined) next.ownerPersonId = patch.ownerPersonId;
  if (patch.ownerName !== undefined) next.ownerName = patch.ownerName;
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.disputed !== undefined) next.disputed = patch.disputed;
  return next;
}

/** R2：从状态原文抽 f（领取版本）；没有 f 字段视为 0（与 decodeStatus 一致）。 */
export const FENCE_OF_STATUS = String.raw`COALESCE(substring(status from '\|f=([0-9]{1,15})(?:\||$)')::bigint, 0)`;
/** R3：领取模板（不含 f）在 `|r=…` 后补 `|f=<旧 f + 1>`；旧 f 取自同一行当前 status（同一条 UPDATE 内）。 */
const BUMP_FENCE_SQL = String.raw`regexp_replace($1::text, '(\|r=[0-9]+)(\||$)', '\1|f=' || (${FENCE_OF_STATUS} + 1)::text || '\2')`;

export interface PostgresStoreOptions {
  /** M08：库已是 v8（有 delivery_due_at 与部分索引）时用索引化到期条件；与文本条件同义（畸形 pending 行除外，见 D53）。 */
  deliveryColumns?: boolean;
}
export function createPostgresPerformanceStore(client: SqlClient, storeOptions: PostgresStoreOptions = {}): PerformanceStore {
  const dueCondition = storeOptions.deliveryColumns
    ? 'delivery_due_at <= $2::timestamptz'
    : "(status = 'pending' OR (status LIKE 'pending|%' AND split_part(status, '|', 2) <= $2))";
  let sourceDraftColumns: boolean | undefined;
  async function sourceDraftColumnsEnabled(query: SqlClient['query'] = (sql, params) => client.query(sql, params)): Promise<boolean> {
    if (sourceDraftColumns !== undefined) return sourceDraftColumns;
    sourceDraftColumns = await hasSourceDraftColumns(query);
    return sourceDraftColumns;
  }
  async function one(sql: string, params: readonly unknown[]): Promise<Row | null> {
    const { rows } = await client.query<Row>(sql, params);
    return rows[0] ?? null;
  }
  async function many(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const { rows } = await client.query<Row>(sql, params);
    return rows;
  }
  /**
   * R1 入账门：同一事务内固定锁序——配置行（策略、高水位、消费租约）FOR SHARE → 人员行（按 ID 排序）FOR SHARE。
   * 撤权（配置 FOR UPDATE）与人员变更（UPSERT 行锁）都与这里互斥：先完成者决定结果。
   */
  async function lockSnapshot(query: SqlClient['query'], guard: CommitGuard): Promise<GateSnapshot> {
    // Keep every acquired lock until commit. Refuse a busy guard row immediately,
    // including when an externally composed transaction holds people/binding before config.
    // The exception must leave the transaction so its caller rolls back all statements.
    async function shared(sql: string, params: readonly unknown[]) {
      try { return await query(`${sql} NOWAIT`, params); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') throw new CommitContentionRejected();
        throw error;
      }
    }
    const config: Record<string, string | null> = {};
    // R1：配置行按统一锁序加锁（高水位第一，见 configLockOrder），与策略变更不交叉死锁。
    for (const key of configLockOrder(guardKeys(guard))) {
      const found = await shared(`SELECT * FROM ${relation('performance_config')} WHERE key=$1 FOR SHARE`, [key]);
      config[key] = found.rows[0] ? text((found.rows[0] as Row).value) : null;
    }
    const people: Record<string, Person | null> = {};
    for (const id of [...(guard.personIds ?? [])].sort()) {
      const found = await shared(`SELECT * FROM ${relation('performance_people')} WHERE person_id=$1 FOR SHARE`, [id]);
      people[id] = found.rows[0] ? personFrom(found.rows[0] as Row) : null;
    }
    let binding: WecomBotBinding | null = null;
    if (guard.binding) {
      const { rows } = await shared(`SELECT * FROM ${relation('wecom_bot_bindings')} WHERE bot_id=$1 AND member_id=$2 FOR SHARE`, [guard.binding.botId, guard.binding.memberId]);
      if (rows.length === 1) {
        const row = rows[0] as Row;
        try { binding = snapshotBinding({ botId: row.bot_id, memberId: row.member_id, corpId: row.corp_id, accountId: row.account_id, version: Number(row.version), active: row.active }); } catch { /* fail closed */ }
      }
    }
    return { config, people, binding };
  }
  /** M03/M04 提交守卫：同一事务内共享锁读；拒绝则仅在本消费者仍是当前持有者时把草稿退回待确认。 */
  async function guardAllows(query: SqlClient['query'], draft: Draft, guard: CommitGuard): Promise<boolean> {
    if ((!guard.validate || await guard.validate()) && guardPasses(guard, await lockSnapshot(query, guard))) return true;
    await revertIfCurrentHolder(query, draft, guard.fence);
    return false;
  }
  /**
   * R2（补充2）：M07 fence 的比对与写入在同一条条件 UPDATE 里完成——关闭草稿的 UPDATE 带
   * `AND EXISTS (租约行 owner/epoch 相等且 until > now)`；租约原文用正则抽取（坏 JSON 判不匹配，不抛错）。
   */
  function fenceClause(guard: CommitGuard | undefined, first: number): { sql: string; params: unknown[] } {
    if (!guard?.fence) return { sql: '', params: [] };
    const m = leaseMatch(guard.fence, first);
    return { sql: ` AND EXISTS (SELECT 1 FROM ${relation('performance_config')} c WHERE ${m.sql})`, params: m.params };
  }
  /** R2/R3：租约行匹配条件（c = performance_config 别名）：owner/epoch 相等且 until > now。 */
  function leaseMatch(f: WriteFence, first: number): { sql: string; params: unknown[] } {
    return {
      sql: `c.key=$${first}`
        + ` AND substring(c.value from '"owner":"([^"\\\\]*)"') = $${first + 1}`
        + ` AND substring(c.value from '"epoch":([0-9]{1,15})[,}]')::bigint = $${first + 2}`
        + ` AND substring(c.value from '"until":([0-9]{1,16})[,}]')::bigint > $${first + 3}`,
      params: [f.key, f.owner, f.epoch, Math.floor(f.nowMs())],
    };
  }
  /**
   * R3/R4：在已有事务里做与统一入口相同的持有者核对——条件锁读租约（必须是本消费者：owner+epoch+until>now）。
   * 不是当前持有者 → 抛 FencedWriteRejected，write 不执行。补偿写也走这里，不得只看「有人持有」或只看 status=confirming。
   */
  async function fencedWriteIn<T>(query: SqlClient['query'], fence: WriteFence | undefined, write: (query: SqlClient['query'], lease: (first: number) => { sql: string; params: unknown[] }) => Promise<T>): Promise<T> {
    if (!fence) return write(query, () => ({ sql: '', params: [] }));
    const held = leaseMatch(fence, 1);
    const locked = await query(`SELECT c.key FROM ${relation('performance_config')} c WHERE ${held.sql} FOR SHARE`, held.params);
    if (locked.rows.length !== 1) throw new FencedWriteRejected();
    return write(query, first => { const m = leaseMatch(fence, first); return { sql: ` AND EXISTS (SELECT 1 FROM ${relation('performance_config')} c WHERE ${m.sql})`, params: m.params }; });
  }
  /**
   * R3（A-P1-1）：唯一的带 epoch 写入入口（消费者拥有的草稿新建/覆盖/状态变更、操作记录、补偿）。
   * 同一事务：① 条件锁读租约行（owner+epoch+until>now，FOR SHARE；接管方的 FOR UPDATE 须等本事务结束）——0 行 → 拒绝；
   * ② 写 SQL 本身再带 `EXISTS(租约匹配)`（write 收到的 lease(first) 生成这一段）。没有 fence（非 OpenDot 装配）时直接写。
   */
  async function fencedWrite<T>(fence: WriteFence | undefined, write: (query: SqlClient['query'], lease: (first: number) => { sql: string; params: unknown[] }) => Promise<T>): Promise<T> {
    if (!fence) return write((sql, params) => client.query(sql, params), () => ({ sql: '', params: [] }));
    return client.transaction(async query => fencedWriteIn(query, fence, write));
  }
  /** R4：仅当本消费者仍是当前持有者时，把 confirming 退回 pending。失权则 0 行，不打扰新持有者。 */
  async function revertIfCurrentHolder(query: SqlClient['query'], draft: Draft, fence: WriteFence | undefined): Promise<boolean> {
    try {
      return await fencedWriteIn(query, fence, async (q, lease) => {
        const l = lease(6);
        const back = await q(
          `UPDATE ${relation('performance_drafts')} SET status=$1, closed_at=$2 WHERE draft_id=$3 AND status=$4 AND NOT EXISTS (SELECT 1 FROM ${relation('performance_drafts')} other WHERE other.reporter_person_id=$5 AND other.status='pending')${l.sql} RETURNING draft_id`,
          ['pending', null, draft.draftId, 'confirming', draft.reporterPersonId, ...l.params],
        );
        return back.rows.length === 1;
      });
    } catch (error) {
      if (error instanceof FencedWriteRejected) return false;
      throw error;
    }
  }
  /** 只有仍在 confirming 的草稿能被本次关闭；返回是否由本次关闭（行锁随 UPDATE 持有到事务结束）。 */
  async function closeConfirming(query: SqlClient['query'], draft: Draft, guard?: CommitGuard): Promise<boolean> {
    if (guard?.active && !guard.active()) return false;
    const fenced = fenceClause(guard, 6);
    const changed = await query(
      `UPDATE ${relation('performance_drafts')} SET status=$1, payload_json=$2, closed_at=$3 WHERE draft_id=$4 AND status=$5${fenced.sql} RETURNING draft_id`,
      [draft.status, JSON.stringify(draft.payload), draft.closedAt, draft.draftId, 'confirming', ...fenced.params],
    );
    return changed.rows.length === 1;
  }
  /** R2/R4：带 fence 的关闭被挡（0 行）且本消费者仍是当前持有者 → 退回待确认。失权则不动新持有者的 confirming。 */
  async function fencedOut(query: SqlClient['query'], draft: Draft, guard?: CommitGuard): Promise<boolean> {
    if (!guard?.fence) return false;
    return revertIfCurrentHolder(query, draft, guard.fence);
  }
  async function voidConflict(draft: Draft, fence?: WriteFence): Promise<void> {
    try {
      await fencedWrite(fence, async (query, lease) => {
        const found = await query(`SELECT * FROM ${relation('performance_drafts')} WHERE draft_id=$1`, [draft.draftId]);
        const current = found.rows[0] as Row | undefined;
        if (!current || text(current.status) !== 'confirming') return;
        const payload = { ...(JSON.parse(text(current.payload_json)) as DraftPayload), outcome: 'conflict' };
        const l = lease(6);
        await query(
          `UPDATE ${relation('performance_drafts')} SET status=$1, payload_json=$2, closed_at=$3 WHERE draft_id=$4 AND status=$5${l.sql} RETURNING draft_id`,
          ['void', JSON.stringify(payload), draft.closedAt, draft.draftId, 'confirming', ...l.params],
        );
      });
    } catch (error) {
      if (error instanceof FencedWriteRejected) return;
      throw error;
    }
  }
  const store: PerformanceStore = {
    async capturePendingArrival() {
      // 替代循环已有的营业配置读取，正常确认不增加往返；序列与草稿 INSERT 共用。
      const row = (await client.query<{ sequence: string; hours: string | null }>(`SELECT nextval('${PERFORMANCE_SCHEMA}.pending_order_seq')::text AS sequence, (SELECT value FROM ${relation('performance_config')} WHERE key=$1) AS hours`, ['front-claw-store-hours'])).rows[0]!;
      return { sequence: row.sequence, hours: row.hours };
    },
    async savePerson(person) {
      await client.query(
        `INSERT INTO ${relation('performance_people')} (person_id, account_id, member_id, display_name, store_id, store_name, tier, roles_json, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (person_id) DO UPDATE SET account_id=EXCLUDED.account_id, member_id=EXCLUDED.member_id, display_name=EXCLUDED.display_name, store_id=EXCLUDED.store_id, store_name=EXCLUDED.store_name, tier=EXCLUDED.tier, roles_json=EXCLUDED.roles_json, active=EXCLUDED.active`,
        [person.personId, person.accountId, person.memberId, person.displayName, person.storeId, person.storeName, person.tier, JSON.stringify(person.roles), person.active],
      );
    },
    async getPerson(personId) {
      const row = await one(`SELECT * FROM ${relation('performance_people')} WHERE person_id=$1`, [personId]);
      return row ? personFrom(row) : null;
    },
    async getPersonByAccount(accountId) {
      const rows = await many(`SELECT * FROM ${relation('performance_people')} WHERE account_id=$1`, [accountId]);
      return rows.length === 1 ? personFrom(rows[0]!) : null;
    },
    async getPersonByMember(memberId) {
      const rows = await many(`SELECT * FROM ${relation('performance_people')} WHERE member_id=$1`, [memberId]);
      return rows.length === 1 ? personFrom(rows[0]!) : null;
    },
    async listPeople() {
      return (await many(`SELECT * FROM ${relation('performance_people')}`)).map(personFrom);
    },
    async saveAlias(alias) {
      const person = await one(`SELECT * FROM ${relation('performance_people')} WHERE person_id=$1`, [alias.personId]);
      if (!person || text(person.store_id) !== alias.storeId) throw Error('alias_person');
      await client.query(
        `INSERT INTO ${relation('performance_aliases')} (store_id, alias, person_id) VALUES ($1,$2,$3)
         ON CONFLICT (store_id, alias) DO UPDATE SET person_id=EXCLUDED.person_id`,
        [alias.storeId, alias.alias, alias.personId],
      );
    },
    async importAlias(alias) {
      const existing = await one(`SELECT * FROM ${relation('performance_aliases')} WHERE store_id=$1 AND alias=$2`, [alias.storeId, alias.alias]);
      if (existing) return false;
      try {
        await client.query(
          `INSERT INTO ${relation('performance_aliases')} (store_id, alias, person_id) VALUES ($1,$2,$3)`,
          [alias.storeId, alias.alias, alias.personId],
        );
        return true;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : '';
        if (code === '23505') return false;
        throw error;
      }
    },
    async listAliases(storeId) {
      const rows = storeId === undefined
        ? await many(`SELECT * FROM ${relation('performance_aliases')}`)
        : await many(`SELECT * FROM ${relation('performance_aliases')} WHERE store_id=$1`, [storeId]);
      return rows.map(row => ({ storeId: text(row.store_id), alias: text(row.alias), personId: text(row.person_id) }));
    },
    async insertEntries(entries) {
      const withSource = await sourceDraftColumnsEnabled();
      for (const entry of entries) {
        if (withSource) {
          await client.query(
            `INSERT INTO ${relation('performance_entries')} (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at, source_draft_id, source_ordinal)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [entry.entryId, entry.storeId, entry.businessDay, entry.customerName, toPgNumeric(entry.amount), entry.amountType, entry.ownerPersonId, entry.ownerName, entry.reporterPersonId, entry.note, entry.status, entry.disputed, entry.createdAt, entry.sourceDraftId ?? null, entry.sourceOrdinal ?? null],
          );
        } else {
          await client.query(
            `INSERT INTO ${relation('performance_entries')} (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [entry.entryId, entry.storeId, entry.businessDay, entry.customerName, toPgNumeric(entry.amount), entry.amountType, entry.ownerPersonId, entry.ownerName, entry.reporterPersonId, entry.note, entry.status, entry.disputed, entry.createdAt],
          );
        }
      }
    },
    async listEntries(filter) {
      const { sql, params } = whereEntries(filter);
      const rows = await many(`SELECT * FROM ${relation('performance_entries')}${sql}`, params);
      return rows.map(entryFrom).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async getEntry(entryId) {
      const row = await one(`SELECT * FROM ${relation('performance_entries')} WHERE entry_id=$1`, [entryId]);
      return row ? entryFrom(row) : null;
    },
    async reviseEntry(entryId, patch, meta) {
      const currentRow = await one(`SELECT * FROM ${relation('performance_entries')} WHERE entry_id=$1`, [entryId]);
      if (!currentRow) throw Error('missing_entry');
      const current = entryFrom(currentRow);
      const next: LedgerEntry = { ...current, ...definedPatch(patch) };
      await client.query(
        `UPDATE ${relation('performance_entries')} SET customer_name=$1, amount=$2, owner_person_id=$3, owner_name=$4, note=$5, status=$6, disputed=$7 WHERE entry_id=$8`,
        [next.customerName, toPgNumeric(next.amount), next.ownerPersonId, next.ownerName, next.note, next.status, next.disputed, entryId],
      );
      await client.query(
        `INSERT INTO ${relation('performance_revisions')} (revision_id, entry_id, editor_person_id, before_json, after_json, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [meta.revisionId, entryId, meta.editorPersonId, JSON.stringify(current), JSON.stringify(next), meta.reason, meta.createdAt],
      );
      return clone(next);
    },
    async listRevisions(entryId) {
      const rows = await many(`SELECT * FROM ${relation('performance_revisions')} WHERE entry_id=$1`, [entryId]);
      return rows.map(row => ({
        revisionId: text(row.revision_id),
        entryId: text(row.entry_id),
        editorPersonId: text(row.editor_person_id),
        beforeJson: text(row.before_json),
        afterJson: text(row.after_json),
        reason: text(row.reason),
        createdAt: text(row.created_at),
      }));
    },
    async saveTarget(target) {
      await client.query(
        `INSERT INTO ${relation('performance_targets')} (store_id, person_id, period_month, amount, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (store_id, person_id, period_month) DO UPDATE SET amount=EXCLUDED.amount, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [target.storeId, target.personId, target.periodMonth, toPgNumeric(target.amount), target.updatedBy, target.updatedAt],
      );
    },
    async getTarget(storeId, personId, periodMonth) {
      const row = await one(`SELECT * FROM ${relation('performance_targets')} WHERE store_id=$1 AND person_id=$2 AND period_month=$3`, [storeId, personId, periodMonth]);
      return row ? targetFrom(row) : null;
    },
    async listTargets(storeId) {
      const rows = storeId === undefined
        ? await many(`SELECT * FROM ${relation('performance_targets')}`)
        : await many(`SELECT * FROM ${relation('performance_targets')} WHERE store_id=$1`, [storeId]);
      return rows.map(targetFrom);
    },
    async saveStoreTarget(target) {
      await client.query(
        `INSERT INTO ${relation('store_targets')} (store_id, period_month, amount, set_by, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (store_id, period_month) DO UPDATE SET amount=EXCLUDED.amount, set_by=EXCLUDED.set_by, updated_at=EXCLUDED.updated_at`,
        [target.storeId, target.periodMonth, toPgNumeric(target.amount), target.setBy, target.updatedAt],
      );
    },
    async getStoreTarget(storeId, periodMonth) {
      const row = await one(`SELECT * FROM ${relation('store_targets')} WHERE store_id=$1 AND period_month=$2`, [storeId, periodMonth]);
      return row ? storeTargetFrom(row) : null;
    },
    async listStoreTargets(storeId) {
      const rows = storeId === undefined
        ? await many(`SELECT * FROM ${relation('store_targets')}`)
        : await many(`SELECT * FROM ${relation('store_targets')} WHERE store_id=$1`, [storeId]);
      return rows.map(storeTargetFrom);
    },
    async commitConfirmingStoreTarget(draft, target, expectedBefore, guard) {
      try {
        return await client.transaction(async query => {
          if (guard && !await guardAllows(query, draft, guard)) return 'denied' as LedgerCommit;
          if (!await closeConfirming(query, draft, guard)) return (await fencedOut(query, draft, guard) ? 'denied' : 'already') as LedgerCommit;
          const keys = [target.storeId, target.periodMonth];
          const found = await query(`SELECT * FROM ${relation('store_targets')} WHERE store_id=$1 AND period_month=$2 FOR UPDATE`, keys);
          const current = found.rows[0] ? storeTargetFrom(found.rows[0]) : null;
          const same = expectedBefore === null ? current === null
            : !!current && current.amount === expectedBefore.amount && current.setBy === expectedBefore.setBy && current.updatedAt === expectedBefore.updatedAt;
          if (!same) throw new CommitConflict();
          if (current) {
            const updated = await query(`UPDATE ${relation('store_targets')} SET amount=$1, set_by=$2, updated_at=$3 WHERE store_id=$4 AND period_month=$5 AND amount=$6 AND set_by=$7 AND updated_at=$8 RETURNING store_id`,
              [toPgNumeric(target.amount), target.setBy, target.updatedAt, ...keys, toPgNumeric(current.amount), current.setBy, current.updatedAt]);
            if (updated.rows.length !== 1) throw new CommitConflict();
          } else {
            await query(`INSERT INTO ${relation('store_targets')} (store_id, period_month, amount, set_by, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (store_id, period_month) DO NOTHING`,
              [...keys, toPgNumeric(target.amount), target.setBy, target.updatedAt]);
            const after = await query(`SELECT * FROM ${relation('store_targets')} WHERE store_id=$1 AND period_month=$2`, keys);
            const row = after.rows[0] ? storeTargetFrom(after.rows[0]) : null;
            if (!row || row.amount !== target.amount || row.setBy !== target.setBy || row.updatedAt !== target.updatedAt) throw new CommitConflict();
          }
          return 'committed' as LedgerCommit;
        });
      } catch (error) {
        if (!(error instanceof CommitConflict)) throw error;
        await voidConflict(draft, guard?.fence);
        return 'conflict';
      }
    },
    async transitionPendingDraft(expected, next, fence, conditions) {
      return fencedWrite(fence, async (query, lease) => {
        const params: unknown[] = [next.status, JSON.stringify(next.payload), next.closedAt, expected.draftId, 'pending', expected.reporterPersonId, expected.storeId, JSON.stringify(expected.payload)];
        let condition = '';
        if (conditions?.expiredAt) { params.push(conditions.expiredAt); condition += ` AND expires_at::timestamptz<=$${params.length}::timestamptz`; }
        if (conditions?.arrivedAt) { params.push(conditions.arrivedAt); condition += ` AND created_at::timestamptz<$${params.length}::timestamptz`; }
        if (conditions?.arrivedSequence) { params.push(conditions.arrivedSequence); condition += ` AND (payload_json::jsonb->'employeeContext'->>'pendingSequence')::bigint<$${params.length}::bigint`; }
        if (conditions?.unexpiredAt) { params.push(conditions.unexpiredAt); condition += ` AND expires_at::timestamptz>$${params.length}::timestamptz`; }
        const l = lease(params.length + 1);
        const { rows } = await query(
          `UPDATE ${relation('performance_drafts')} SET status=$1, payload_json=$2, closed_at=$3 WHERE draft_id=$4 AND status=$5 AND reporter_person_id=$6 AND store_id=$7 AND payload_json::jsonb=$8::jsonb${condition}${l.sql} RETURNING draft_id`,
          [...params, ...l.params],
        );
        return rows.length === 1;
      });
    },
    async claimPendingDraft(draftId) {
      const { rows } = await client.query(
        `UPDATE ${relation('performance_drafts')} SET status=$1 WHERE draft_id=$2 AND status=$3 RETURNING *`,
        ['confirming', draftId, 'pending'],
      );
      return rows[0] ? draftFrom(rows[0]) : null;
    },
    async commitConfirmingDraft(draft, entries, guard) {
      const withSource = await sourceDraftColumnsEnabled();
      return client.transaction(async query => {
        // 与 updateConfigLocked 的 FOR UPDATE、savePerson 的行锁互斥：撤权/停用先提交则此处读到新值；此处先持锁则对方等本提交结束。
        if (guard && !await guardAllows(query, draft, guard)) return -1;
        // R6 / M04-01：同店同营业日事务内咨询锁，查重与写入在同一事务。绝不以客户+营业日做唯一约束。
        // 锁键用整数（与 MemorySql 既有 pg_advisory_xact_lock($1,$2) 形状一致）；真实冲突由 PG 集成测试覆盖。
        const lockKey = (value: string): number => {
          let hash = 0;
          for (let i = 0; i < value.length; i += 1) hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
          return hash;
        };
        await query('SELECT pg_advisory_xact_lock($1, $2)', [lockKey(draft.storeId), lockKey(draft.businessDay)]);
        const closed = await closeConfirming(query, draft, guard);
        if (!closed) {
          // 补偿仅当前持有者能退回；退回或带 fence 的关闭失败都视为拒绝（-1）。
          // 无 fence 且未认领（仍 pending）走原来的 0，避免把「无认领 commit」当成已入账。
          // R17 / D151：本次没有把 confirming 改成 confirmed，返回 0（已处理），不把已有入账行数当成「本次写入」。
          const reverted = await fencedOut(query, draft, guard);
          if (reverted || guard?.fence) return -1;
          return 0;
        }
        const explicitNew = draft.payload.type === 'report' && draft.payload.explicitNew === true;
        const contentKey = (row: { ownerPersonId: string; amount: string | number; customerName: string | null; note: string }) =>
          JSON.stringify([row.ownerPersonId, fromPgNumeric(row.amount), row.customerName, row.note]);
        const remaining = new Map<string, number>();
        if (closed && !explicitNew && entries.length) {
          const first = entries[0]!;
          const existing = await query(
            `SELECT * FROM ${relation('performance_entries')} WHERE store_id=$1 AND business_day=$2 AND status=$3`,
            [first.storeId, first.businessDay, 'confirmed'],
          );
          for (const row of existing.rows) {
            const key = contentKey({
              ownerPersonId: String(row.owner_person_id ?? ''),
              amount: row.amount as string | number,
              customerName: (row.customer_name as string | null) ?? null,
              note: String(row.note ?? ''),
            });
            remaining.set(key, (remaining.get(key) ?? 0) + 1);
          }
        }
        for (const entry of closed ? entries : []) {
          if (!explicitNew) {
            const key = contentKey({ ownerPersonId: entry.ownerPersonId, amount: toPgNumeric(entry.amount), customerName: entry.customerName, note: entry.note });
            const left = remaining.get(key) ?? 0;
            if (left > 0) { remaining.set(key, left - 1); continue; }
          }
          if (withSource) {
            await query(
              `INSERT INTO ${relation('performance_entries')} (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at, source_draft_id, source_ordinal)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               ON CONFLICT (source_draft_id, source_ordinal) DO NOTHING`,
              [entry.entryId, entry.storeId, entry.businessDay, entry.customerName, toPgNumeric(entry.amount), entry.amountType, entry.ownerPersonId, entry.ownerName, entry.reporterPersonId, entry.note, entry.status, entry.disputed, entry.createdAt, entry.sourceDraftId ?? entry.entryId, entry.sourceOrdinal ?? 0],
            );
          } else {
            await query(
              `INSERT INTO ${relation('performance_entries')} (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (entry_id) DO NOTHING`,
              [entry.entryId, entry.storeId, entry.businessDay, entry.customerName, toPgNumeric(entry.amount), entry.amountType, entry.ownerPersonId, entry.ownerName, entry.reporterPersonId, entry.note, entry.status, entry.disputed, entry.createdAt],
            );
          }
        }
        const persisted: LedgerEntry[] = [];
        for (const entry of entries) {
          const found = await query(`SELECT * FROM ${relation('performance_entries')} WHERE entry_id=$1`, [entry.entryId]);
          if (found.rows.length) persisted.push(entry);
        }
        // 本次确实关闭了草稿：即使内容去重后没有新行，也返回至少 1，表示「这次改到了状态」。
        const settled = settledReportDraft(draft, persisted);
        await query(`UPDATE ${relation('performance_drafts')} SET payload_json=$1 WHERE draft_id=$2 AND status=$3 RETURNING draft_id`, [JSON.stringify(settled.payload), draft.draftId, 'confirmed']);
        return Math.max(1, persisted.length);
      });
    },
    async commitConfirmingTarget(draft, target, expectedBefore, guard) {
      try {
        return await client.transaction(async query => {
          if (guard && !await guardAllows(query, draft, guard)) return 'denied' as LedgerCommit;
          if (!await closeConfirming(query, draft, guard)) return (await fencedOut(query, draft, guard) ? 'denied' : 'already') as LedgerCommit;
          const keys = [target.storeId, target.personId, target.periodMonth];
          const found = await query(`SELECT * FROM ${relation('performance_targets')} WHERE store_id=$1 AND person_id=$2 AND period_month=$3 FOR UPDATE`, keys);
          const current = found.rows[0] ? targetFrom(found.rows[0]) : null;
          const same = expectedBefore === null ? current === null
            : !!current && current.amount === expectedBefore.amount && current.updatedBy === expectedBefore.updatedBy && current.updatedAt === expectedBefore.updatedAt;
          if (!same) throw new CommitConflict();
          if (current) {
            const updated = await query(`UPDATE ${relation('performance_targets')} SET amount=$1, updated_by=$2, updated_at=$3 WHERE store_id=$4 AND person_id=$5 AND period_month=$6 AND amount=$7 AND updated_by=$8 AND updated_at=$9 RETURNING store_id`,
              [toPgNumeric(target.amount), target.updatedBy, target.updatedAt, ...keys, toPgNumeric(current.amount), current.updatedBy, current.updatedAt]);
            if (updated.rows.length !== 1) throw new CommitConflict();
          } else {
            await query(`INSERT INTO ${relation('performance_targets')} (store_id, person_id, period_month, amount, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (store_id, person_id, period_month) DO NOTHING`,
              [...keys, toPgNumeric(target.amount), target.updatedBy, target.updatedAt]);
            // 并发插入时后到者 DO NOTHING：读回核对确实是本次写入，否则视为冲突回滚。
            const after = await query(`SELECT * FROM ${relation('performance_targets')} WHERE store_id=$1 AND person_id=$2 AND period_month=$3`, keys);
            const row = after.rows[0] ? targetFrom(after.rows[0]) : null;
            if (!row || row.amount !== target.amount || row.updatedBy !== target.updatedBy || row.updatedAt !== target.updatedAt) throw new CommitConflict();
          }
          return 'committed' as LedgerCommit;
        });
      } catch (error) {
        if (!(error instanceof CommitConflict)) throw error;
        await voidConflict(draft, guard?.fence);
        return 'conflict';
      }
    },
    async commitConfirmingCorrection(draft, writes, meta, notices, guard) {
      try {
        return await client.transaction(async query => {
          if (guard && !await guardAllows(query, draft, guard)) return 'denied' as LedgerCommit;
          if (!await closeConfirming(query, draft, guard)) return (await fencedOut(query, draft, guard) ? 'denied' : 'already') as LedgerCommit;
          // 固定按账目 ID 加锁，避免两份更正交叉等待。
          for (const write of [...writes].sort((a, b) => a.entryId.localeCompare(b.entryId))) {
            const found = await query(`SELECT * FROM ${relation('performance_entries')} WHERE entry_id=$1 FOR UPDATE`, [write.entryId]);
            const current = found.rows[0] ? entryFrom(found.rows[0]) : null;
            if (!current || entryVersion(current) !== write.beforeJson) throw new CommitConflict();
            const next: LedgerEntry = { ...current, ...definedPatch(write.patch) };
            await query(
              `UPDATE ${relation('performance_entries')} SET customer_name=$1, amount=$2, owner_person_id=$3, owner_name=$4, note=$5, status=$6, disputed=$7 WHERE entry_id=$8`,
              [next.customerName, toPgNumeric(next.amount), next.ownerPersonId, next.ownerName, next.note, next.status, next.disputed, write.entryId],
            );
            await query(
              `INSERT INTO ${relation('performance_revisions')} (revision_id, entry_id, editor_person_id, before_json, after_json, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (revision_id) DO NOTHING`,
              [write.revisionId, write.entryId, meta.editorPersonId, JSON.stringify(current), JSON.stringify(next), meta.reason, meta.createdAt],
            );
          }
          for (const notice of notices) {
            await query(
              `INSERT INTO ${relation('performance_notifications')} (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (notification_id) DO NOTHING`,
              [notice.notificationId, notice.kind, notice.recipientPersonId, notice.body, notice.status, notice.relatedId, notice.createdAt, notice.sentAt],
            );
          }
          return 'committed' as LedgerCommit;
        });
      } catch (error) {
        if (!(error instanceof CommitConflict)) throw error;
        await voidConflict(draft, guard?.fence);
        return 'conflict';
      }
    },
    async commitConfirmingAppointments(draft, appointments, options) {
      if (options) {
        // M05 登记即成立：策略 FOR SHARE → 草稿条件转换 → 预约 INSERT…RETURNING（未插入 = 同内容已登记 → 回滚并作废）→ 按锁住的策略过滤提醒 → 提醒 INSERT。
        try {
          return await client.transaction(async query => {
            let raw: string | null = null;
            let snapshot: GateSnapshot = { config: {}, people: {} };
            if (options.guard) {
              snapshot = await lockSnapshot(query, options.guard);
              raw = snapshot.config[options.guard.key] ?? null;
              if (!guardPasses(options.guard, snapshot)) {
                await query(`UPDATE ${relation('performance_drafts')} SET status=$1, closed_at=$2 WHERE draft_id=$3 AND status=$4 RETURNING draft_id`, ['pending', null, draft.draftId, 'confirming']);
                return { total: 0, claimed: false, outcome: 'denied' as const, noticesWritten: 0 };
              }
            }
            if (!await closeConfirming(query, draft, options.guard)) {
              return { total: 0, claimed: false, outcome: await fencedOut(query, draft, options.guard) ? 'denied' as const : 'already' as const, noticesWritten: 0 };
            }
            for (const appointment of appointments) {
              const inserted = await query(
                `INSERT INTO ${relation('performance_appointments')} (appointment_id, store_id, employee_person_id, customer_name, when_text, note, status, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (appointment_id) DO NOTHING RETURNING appointment_id`,
                [appointment.appointmentId, appointment.storeId, appointment.employeePersonId, appointment.customerName, appointment.whenText, appointment.note, appointment.status, appointment.createdAt],
              );
              if (inserted.rows.length !== 1) throw new CommitConflict();
            }
            let noticesWritten = 0;
            for (const notice of options.notices) {
              if (options.noticeAllowed && !options.noticeAllowed(raw, notice, snapshot)) continue;
              const written = await query(
                `INSERT INTO ${relation('performance_notifications')} (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (notification_id) DO NOTHING RETURNING notification_id`,
                [notice.notificationId, notice.kind, notice.recipientPersonId, notice.body, notice.status, notice.relatedId, notice.createdAt, notice.sentAt],
              );
              noticesWritten += written.rows.length;
            }
            return { total: appointments.length, claimed: true, outcome: 'committed' as const, noticesWritten };
          });
        } catch (error) {
          if (!(error instanceof CommitConflict)) throw error;
          const current = await one(`SELECT * FROM ${relation('performance_drafts')} WHERE draft_id=$1`, [draft.draftId]);
          if (current && text(current.status) === 'confirming') {
            const payload = { ...(JSON.parse(text(current.payload_json)) as DraftPayload), outcome: 'duplicate' };
            await client.query(`UPDATE ${relation('performance_drafts')} SET status=$1, payload_json=$2, closed_at=$3 WHERE draft_id=$4 AND status=$5 RETURNING draft_id`,
              ['void', JSON.stringify(payload), draft.closedAt, draft.draftId, 'confirming']);
          }
          return { total: 0, claimed: false, outcome: 'duplicate' as const, noticesWritten: 0 };
        }
      }
      return client.transaction(async query => {
        for (const appointment of appointments) {
          await query(
            `INSERT INTO ${relation('performance_appointments')} (appointment_id, store_id, employee_person_id, customer_name, when_text, note, status, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (appointment_id) DO NOTHING`,
            [appointment.appointmentId, appointment.storeId, appointment.employeePersonId, appointment.customerName, appointment.whenText, appointment.note, appointment.status, appointment.createdAt],
          );
        }
        const updated = await query(
          `UPDATE ${relation('performance_drafts')} SET status=$1, payload_json=$2, closed_at=$3 WHERE draft_id=$4 AND status=$5 RETURNING draft_id`,
          [draft.status, JSON.stringify(draft.payload), draft.closedAt, draft.draftId, 'confirming'],
        );
        let total = 0;
        for (const appointment of appointments) {
          const found = await query(`SELECT * FROM ${relation('performance_appointments')} WHERE appointment_id=$1`, [appointment.appointmentId]);
          if (found.rows.length) total += 1;
        }
        const claimed = updated.rows.length === 1;
        return { total, claimed, outcome: claimed ? 'committed' as const : 'already' as const, noticesWritten: 0 };
      });
    },
    async confirmPendingAppointment(appointmentId) {
      const updated = await client.query(
        `UPDATE ${relation('performance_appointments')} SET status=$1 WHERE appointment_id=$2 AND status=$3 RETURNING appointment_id`,
        ['confirmed', appointmentId, 'pending_manager'],
      );
      if (updated.rows.length === 1) return 'confirmed';
      const row = await one(`SELECT * FROM ${relation('performance_appointments')} WHERE appointment_id=$1`, [appointmentId]);
      if (!row) return 'missing';
      return text(row.status) === 'confirmed' ? 'already' : 'missing';
    },
    async claimDraftNotice(draftId, field) {
      const column = field === 'reminder' ? 'reminder' : 'void_notice';
      const { rows } = await client.query(
        `UPDATE ${relation('performance_drafts')} SET ${column}=$1 WHERE draft_id=$2 AND ${column}=$3 RETURNING draft_id`,
        ['claimed', draftId, 'none'],
      );
      return rows.length > 0;
    },
    async replacePendingReport(write, fence) {
      const w = clone(write);
      return client.transaction(query => fencedWriteIn(query, fence, async (q, lease) => {
        // 员工行锁统一串行化草稿与各会话 config；唯一索引兜底不走本协议的草稿写入。
        await q(`SELECT * FROM ${relation('performance_people')} WHERE person_id=$1 FOR UPDATE`, [w.reporterPersonId]);
        const no = { saved: false, drafts: [], asks: [] };
        if (w.draft && (await q(`SELECT * FROM ${relation('performance_drafts')} WHERE draft_id=$1`, [w.draft.draftId])).rows.length) return no;
        const prefix = `employee-loop:new-customer-ask:${w.reporterPersonId}:`;
        const configs = (await q(`SELECT * FROM ${relation('performance_config')} WHERE starts_with(key,$1) FOR UPDATE`, [prefix])).rows as Row[];
        if (w.expectedAsk) {
          const e = w.expectedAsk, raw = configs.find(r => r.key === e.key)?.value;
          if (raw !== e.value) return no;
          const a = JSON.parse(String(raw));
          if (!(sequenceBefore(a.issuedSequence, e.arrivedSequence)) || !(Date.parse(a.expiresAt ?? '') > Date.parse(w.at))) return no;
          const consumed = await q(`UPDATE ${relation('performance_config')} SET value=$1 WHERE key=$2 AND value=$3 AND (value::jsonb->>'issuedSequence')::bigint<$4::bigint AND (value::jsonb->>'expiresAt')::timestamptz>$5::timestamptz RETURNING key`, ['', e.key, e.value, e.arrivedSequence, w.at]);
          if (consumed.rows.length !== 1) return no;
        }
        const rows = (await q(`SELECT * FROM ${relation('performance_drafts')} WHERE reporter_person_id=$1 AND status=$2 FOR UPDATE`, [w.reporterPersonId, 'pending'])).rows as Row[];
        const drafts = rows.map(draftFrom), asks = configs.filter(r => !!r.value && r.key !== w.expectedAsk?.key);
        // D174 冲突处理：事务内先作废原 pending，再插新项；不重试入账或未知业务结果。
        for (const d of drafts) await q(`UPDATE ${relation('performance_drafts')} SET status=$1, closed_at=$2 WHERE draft_id=$3 AND status=$4`, ['void', w.at, d.draftId, 'pending']);
        for (const a of asks) await q(`UPDATE ${relation('performance_config')} SET value=$1 WHERE key=$2 AND value=$3`, ['', a.key, a.value]);
        const replaced = drafts.length > 0 || asks.length > 0;
        if (w.draft) {
          const d = w.draft;
          d.createdAt = w.at;
          if (replaced && 'employeeContext' in d.payload && d.payload.employeeContext) d.payload.employeeContext.replacedPending = true;
          const l = lease(13);
          await q(`INSERT INTO ${relation('performance_drafts')} (draft_id, reporter_person_id, store_id, business_day, expires_at, kind, payload_json, status, reminder, void_notice, created_at, closed_at)
            SELECT $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,jsonb_set($7::jsonb,'{employeeContext,pendingSequence}',to_jsonb(nextval('front_claw_perf.pending_order_seq')::text))::text,$8::text,$9::text,$10::text,$11::text,$12::text WHERE TRUE${l.sql} ON CONFLICT (draft_id) DO NOTHING`,
            [d.draftId, d.reporterPersonId, d.storeId, d.businessDay, d.expiresAt, d.kind, JSON.stringify(d.payload), d.status, d.reminder, d.voidNotice, d.createdAt, d.closedAt, ...l.params]);
        }
        if (w.ask) {
          const a = JSON.parse(w.ask.value);
          a.issuedAt = w.at;
          if (replaced) a.replacedPending = true;
          const l = lease(3);
          await q(`INSERT INTO ${relation('performance_config')} (key, value) SELECT $1::text,jsonb_set($2::jsonb,'{issuedSequence}',to_jsonb(nextval('front_claw_perf.pending_order_seq')::text))::text WHERE TRUE${l.sql} ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [w.ask.key, JSON.stringify(a), ...l.params]);
        }
        return { saved: true, drafts, asks: asks.map(r => String(r.value)) };
      }));
    },
    async saveDraft(draft, options) {
      if (options?.pendingReport) return store.replacePendingReport(options.pendingReport, options.fence);
      await fencedWrite(options?.fence, async (query, lease) => {
        const l = lease(13);
        const inserted = await query(
        `INSERT INTO ${relation('performance_drafts')} (draft_id, reporter_person_id, store_id, business_day, expires_at, kind, payload_json, status, reminder, void_notice, created_at, closed_at)
         SELECT $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text WHERE TRUE${l.sql}
         ON CONFLICT (draft_id) DO ${options?.ifAbsent ? 'NOTHING' : 'UPDATE SET reporter_person_id=EXCLUDED.reporter_person_id, store_id=EXCLUDED.store_id, business_day=EXCLUDED.business_day, expires_at=EXCLUDED.expires_at, kind=EXCLUDED.kind, payload_json=EXCLUDED.payload_json, status=EXCLUDED.status, reminder=EXCLUDED.reminder, void_notice=EXCLUDED.void_notice, created_at=EXCLUDED.created_at, closed_at=EXCLUDED.closed_at'}`,
        [draft.draftId, draft.reporterPersonId, draft.storeId, draft.businessDay, draft.expiresAt, draft.kind, JSON.stringify(draft.payload), draft.status, draft.reminder, draft.voidNotice, draft.createdAt, draft.closedAt, ...l.params],
        );
        return inserted;
      });
    },
    async getDraft(draftId) {
      const row = await one(`SELECT * FROM ${relation('performance_drafts')} WHERE draft_id=$1`, [draftId]);
      return row ? draftFrom(row) : null;
    },
    async getOpenDraft(reporterPersonId) {
      const rows = await many(`SELECT * FROM ${relation('performance_drafts')} WHERE reporter_person_id=$1 AND status=$2`, [reporterPersonId, 'pending']);
      const last = rows[rows.length - 1];
      return last ? draftFrom(last) : null;
    },
    async listDrafts(filter) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.status !== undefined) { params.push(filter.status); clauses.push(`status=$${params.length}`); }
      if (filter?.kind !== undefined) { params.push(filter.kind); clauses.push(`kind=$${params.length}`); }
      if (filter?.reporterPersonId !== undefined) { params.push(filter.reporterPersonId); clauses.push(`reporter_person_id=$${params.length}`); }
      if (filter?.storeId !== undefined) { params.push(filter.storeId); clauses.push(`store_id=$${params.length}`); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return (await many(`SELECT * FROM ${relation('performance_drafts')}${where}`, params)).map(draftFrom);
    },
    async saveAppointment(appointment) {
      await client.query(
        `INSERT INTO ${relation('performance_appointments')} (appointment_id, store_id, employee_person_id, customer_name, when_text, note, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (appointment_id) DO UPDATE SET status=EXCLUDED.status`,
        [appointment.appointmentId, appointment.storeId, appointment.employeePersonId, appointment.customerName, appointment.whenText, appointment.note, appointment.status, appointment.createdAt],
      );
    },
    async listAppointments(filter) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.storeId !== undefined) { params.push(filter.storeId); clauses.push(`store_id=$${params.length}`); }
      if (filter?.status !== undefined) { params.push(filter.status); clauses.push(`status=$${params.length}`); }
      if (filter?.employeePersonId !== undefined) { params.push(filter.employeePersonId); clauses.push(`employee_person_id=$${params.length}`); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return (await many(`SELECT * FROM ${relation('performance_appointments')}${where}`, params)).map(appointmentFrom).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async insertNotification(notification) {
      assertStatus(notification.status);
      await client.query(
        `INSERT INTO ${relation('performance_notifications')} (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [notification.notificationId, notification.kind, notification.recipientPersonId, notification.body, notification.status, notification.relatedId, notification.createdAt, notification.sentAt],
      );
    },
    async updateNotificationStatus(notificationId, status, sentAt) {
      const updated = await client.query(`UPDATE ${relation('performance_notifications')} SET status=$1, sent_at=$2 WHERE notification_id=$3`, [status, sentAt, notificationId]);
      if (!updated.rows.length) {
        const existing = await one(`SELECT * FROM ${relation('performance_notifications')} WHERE notification_id=$1`, [notificationId]);
        if (!existing) throw Error('missing_notification');
      }
    },
    async listNotifications() {
      return (await many(`SELECT * FROM ${relation('performance_notifications')}`)).map(notificationFrom);
    },
    async enqueueNotification(notification) {
      assertStatus(notification.status);
      const { rows } = await client.query(
        `INSERT INTO ${relation('performance_notifications')} (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (notification_id) DO NOTHING RETURNING notification_id`,
        [notification.notificationId, notification.kind, notification.recipientPersonId, notification.body, notification.status, notification.relatedId, notification.createdAt, notification.sentAt],
      );
      return rows.length === 1;
    },
    async claimDueNotifications(options) {
      // M06：只领出站箱行（确定性 64 位十六进制 ID；旧入口 UUID 行不碰）；到期判定在 SQL 内完成；SKIP LOCKED 让并发派发者各取不同行；同一事务内改写为 claimed/unknown 后提交。
      return client.transaction(async query => {
        const { rows } = await query(
          `SELECT * FROM ${relation('performance_notifications')}
            WHERE kind = ANY($1::text[]) AND notification_id ~ '^[0-9a-f]{64}$' AND ${dueCondition}
            ORDER BY created_at, notification_id LIMIT $3 FOR UPDATE SKIP LOCKED`,
          [[...options.kinds], options.nowIso, options.limit],
        );
        const claimed: Notification[] = [], expired: Notification[] = [];
        for (const row of rows) {
          const current = notificationFrom(row);
          const raw = text(row.status);
          const next = claimTransition(raw, options, current.notificationId);
          if (!next) continue; // R1：畸形原文不领取（v7 文本条件会选中，在这里隔离）
          // R3（f 单调）：f 由数据库在同一条 UPDATE 里按旧值 +1（f = f + 1）；应用层只给不含 f 的模板。f 到顶 → 0 行（不领取）。
          const updated = next.bumpFence
            ? await query(`UPDATE ${relation('performance_notifications')} SET status=${BUMP_FENCE_SQL} WHERE notification_id=$2 AND status=$3 AND ${FENCE_OF_STATUS} < ${MAX_FENCE} RETURNING *`, [next.raw, current.notificationId, raw])
            : await query(`UPDATE ${relation('performance_notifications')} SET status=$1 WHERE notification_id=$2 AND status=$3 RETURNING *`, [next.raw, current.notificationId, raw]);
          if (updated.rows[0]) (next.expired ? expired : claimed).push(notificationFrom(updated.rows[0] as Row));
        }
        return { claimed, expired };
      });
    },
    async beginNotificationSend(notificationId, expectedRaw, options) {
      // M06 锁顺序与 M03/M04/M05 一致：配置（策略等）FOR SHARE → 业务行 FOR UPDATE。撤权方持策略 FOR UPDATE 时这里等待，提交后按新策略判定。
      return client.transaction(async query => {
        const config: Record<string, string | null> = {};
        for (const key of configLockOrder(options.lockKeys)) {
          const found = await query(`SELECT * FROM ${relation('performance_config')} WHERE key=$1 FOR SHARE`, [key]);
          config[key] = found.rows[0] ? text((found.rows[0] as Row).value) : null;
        }
        // R1 出口 (b)：收件人档案、关联草稿/预约在同一事务内 FOR SHARE 重读（锁序：配置 → 人员 → 草稿 → 预约 → 通知行）。
        const current: SendSnapshot = { people: {}, drafts: {}, appointments: {} };
        for (const id of [...(options.personIds ?? [])].sort()) {
          const found = await query(`SELECT * FROM ${relation('performance_people')} WHERE person_id=$1 FOR SHARE`, [id]);
          current.people[id] = found.rows[0] ? personFrom(found.rows[0] as Row) : null;
        }
        for (const id of [...(options.draftIds ?? [])].sort()) {
          const found = await query(`SELECT * FROM ${relation('performance_drafts')} WHERE draft_id=$1 FOR SHARE`, [id]);
          current.drafts[id] = found.rows[0] ? draftFrom(found.rows[0] as Row) : null;
        }
        for (const id of [...(options.appointmentIds ?? [])].sort()) {
          const found = await query(`SELECT * FROM ${relation('performance_appointments')} WHERE appointment_id=$1 FOR SHARE`, [id]);
          current.appointments[id] = found.rows[0] ? appointmentFrom(found.rows[0] as Row) : null;
        }
        const locked = await query(`SELECT * FROM ${relation('performance_notifications')} WHERE notification_id=$1 FOR UPDATE`, [notificationId]);
        const row = locked.rows[0] as Row | undefined;
        if (!row || text(row.status) !== expectedRaw) return 'lost' as const;
        const decision = options.decide(config, notificationFrom(row), current);
        if (decision.nextRaw !== null) {
          assertStatus(decision.nextRaw);
          // R2（补充2）：同一条条件 UPDATE 里再比对 f（领取版本）；0 行 = 被挡。
          // R3：f 条件保留——拆成结构化列后，f 是主要护栏；前提是任何路径都不让 f 回退（R3 起 f 只由领取时的 f = f + 1 增长，重试/终态/补发都保留）。
          // 目前 status=$3 原文相等已蕴含 f 相等（R2a 结论，限当前合法状态域）；tests/r3 另有“去掉原文比对、只靠 f 也挡得住”的防回归。
          const written = await query(`UPDATE ${relation('performance_notifications')} SET status=$1 WHERE notification_id=$2 AND status=$3 AND ${FENCE_OF_STATUS} = $4 RETURNING notification_id`,
            [decision.nextRaw, notificationId, expectedRaw, decodeStatus(expectedRaw).delivery.fence]);
          if (written.rows.length !== 1) return 'lost' as const;
        }
        return decision.ok ? 'sending' as const : decision.nextRaw === null ? 'lost' as const : 'refused' as const;
      });
    },
    async transitionNotification(notificationId, expectedRaw, nextRaw, sentAt, fence) {
      assertStatus(nextRaw);
      if (!fence) {
        const { rows } = await client.query(
          `UPDATE ${relation('performance_notifications')} SET status=$1, sent_at=$2 WHERE notification_id=$3 AND status=$4 RETURNING notification_id`,
          [nextRaw, sentAt, notificationId, expectedRaw],
        );
        return rows.length === 1;
      }
      // R2（补充2）：fencing 的比对与写入在同一条条件 UPDATE 里完成：原文相等、f = 领取版本、阶段为 claimed/sending、
      // 领取租约到期时间 > now；0 行 = 被挡（过期或被他人重领）。不再先 SELECT 再判。
      if (!resultFenceHolds(expectedRaw, expectedRaw, fence)) return false;
      const { rows } = await client.query(
        `UPDATE ${relation('performance_notifications')} SET status=$1, sent_at=$2
          WHERE notification_id=$3 AND status=$4 AND ${FENCE_OF_STATUS} = $5
            AND split_part(status, '|', 1) = 'pending' AND split_part(status, '|', 3) IN ('claimed', 'sending') AND split_part(status, '|', 2) > $6
          RETURNING notification_id`,
        [nextRaw, sentAt, notificationId, expectedRaw, fence.epoch, fence.nowIso],
      );
      return rows.length === 1;
    },
    async requeueNotificationWithAudit(notificationId, expectedRaw, nextRaw, audit) {
      assertStatus(nextRaw);
      return client.transaction(async query => {
        const { rows } = await query(
          `UPDATE ${relation('performance_notifications')} SET status=$1, sent_at=$2 WHERE notification_id=$3 AND status=$4 RETURNING notification_id`,
          [nextRaw, null, notificationId, expectedRaw],
        );
        if (rows.length !== 1) return false;
        const written = await query(`INSERT INTO ${relation('performance_config')} (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key`, [audit.key, audit.value]);
        if (written.rows.length !== 1) throw new AuditExists();
        return true;
      }).catch(error => { if (error instanceof AuditExists) return false; throw error; });
    },
    async getConfig(key) {
      const row = await one(`SELECT * FROM ${relation('performance_config')} WHERE key=$1`, [key]);
      return row ? text(row.value) : null;
    },
    async updateConfigLocked(key, extraKeys, mutate) {
      return client.transaction(async query => {
        const current: Record<string, string | null> = {};
        // R1：统一锁序（configLockOrder：高水位第一、其余字典序 → 人员 → 草稿 → 预约 → 通知）。
        for (const name of configLockOrder([key, ...extraKeys])) {
          const row = await query(`SELECT * FROM ${relation('performance_config')} WHERE key=$1 FOR UPDATE`, [name]);
          current[name] = row.rows[0] ? text(row.rows[0].value) : null;
        }
        const writes = mutate(current);
        if (!writes) return false;
        for (const [name, value] of Object.entries(writes)) {
          await query(`INSERT INTO ${relation('performance_config')} (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [name, value]);
        }
        return true;
      });
    },
    async insertConfigIfAbsent(key, value) {
      const result = await client.query<{ key: string }>(
        `INSERT INTO ${relation('performance_config')} (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, value]);
      return result.rows.length === 1;
    },
    async compareAndSetPendingAsk(key, expected, value, conditions, fence) {
      assertWritableConfigKey(key);
      return fencedWrite(fence, async (query, lease) => {
        const params: unknown[] = [value, key, expected];
        let condition = '';
        if (conditions.expiredAt) { params.push(conditions.expiredAt); condition += ` AND (value::jsonb->>'expiresAt')::timestamptz<=$${params.length}::timestamptz`; }
        if (conditions.arrivedAt) { params.push(conditions.arrivedAt); condition += ` AND (value::jsonb->>'issuedAt')::timestamptz<$${params.length}::timestamptz`; }
        if (conditions.arrivedSequence) { params.push(conditions.arrivedSequence); condition += ` AND (value::jsonb->>'issuedSequence')::bigint<$${params.length}::bigint`; }
        if (conditions.unexpiredAt) { params.push(conditions.unexpiredAt); condition += ` AND (value::jsonb->>'expiresAt')::timestamptz>$${params.length}::timestamptz`; }
        const l = lease(params.length + 1);
        const result = await query(`UPDATE ${relation('performance_config')} SET value=$1 WHERE key=$2 AND value=$3${condition}${l.sql} RETURNING key`, [...params, ...l.params]);
        return result.rows.length === 1;
      });
    },
    async setConfig(key, value, fence) {
      assertWritableConfigKey(key);
      await fencedWrite(fence, async (query, lease) => {
        const l = lease(3);
        const written = await query(
          `INSERT INTO ${relation('performance_config')} (key, value) SELECT $1::text, $2::text WHERE TRUE${l.sql} ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value RETURNING key`,
          [key, value, ...l.params],
        );
        if (fence && written.rows.length !== 1) throw new FencedWriteRejected();
      });
    },
  };
  return store;
}

function whereEntries(filter: EntryFilter | undefined): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    clauses.push(`${column}=$${params.length}`);
  };
  add('store_id', filter?.storeId);
  add('business_day', filter?.businessDay);
  add('reporter_person_id', filter?.reporterPersonId);
  add('owner_person_id', filter?.ownerPersonId);
  add('status', filter?.status);
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function targetFrom(row: Row): Target {
  return {
    storeId: text(row.store_id),
    personId: text(row.person_id),
    periodMonth: text(row.period_month),
    amount: fromPgNumeric(row.amount),
    updatedBy: text(row.updated_by),
    updatedAt: text(row.updated_at),
  };
}

function storeTargetFrom(row: Row): StoreTarget {
  return {
    storeId: text(row.store_id),
    periodMonth: text(row.period_month),
    amount: fromPgNumeric(row.amount),
    setBy: text(row.set_by),
    updatedAt: text(row.updated_at),
  };
}

function draftFrom(row: Row): Draft {
  return {
    draftId: text(row.draft_id),
    reporterPersonId: text(row.reporter_person_id),
    storeId: text(row.store_id),
    businessDay: text(row.business_day),
    expiresAt: text(row.expires_at),
    kind: text(row.kind) as Draft['kind'],
    payload: JSON.parse(text(row.payload_json)) as DraftPayload,
    status: text(row.status) as Draft['status'],
    reminder: text(row.reminder) as Draft['reminder'],
    voidNotice: text(row.void_notice) as Draft['voidNotice'],
    createdAt: text(row.created_at),
    closedAt: nullableText(row.closed_at),
  };
}

function appointmentFrom(row: Row): Appointment {
  return {
    appointmentId: text(row.appointment_id),
    storeId: text(row.store_id),
    employeePersonId: text(row.employee_person_id),
    customerName: text(row.customer_name),
    whenText: text(row.when_text),
    note: text(row.note),
    status: text(row.status) as Appointment['status'],
    createdAt: text(row.created_at),
  };
}

function notificationFrom(row: Row): Notification {
  return withDelivery({
    notificationId: text(row.notification_id),
    kind: text(row.kind) as Notification['kind'],
    recipientPersonId: text(row.recipient_person_id),
    body: text(row.body),
    status: text(row.status) as Notification['status'],
    relatedId: text(row.related_id),
    createdAt: text(row.created_at),
    sentAt: nullableText(row.sent_at),
  });
}

export type { Revision };
