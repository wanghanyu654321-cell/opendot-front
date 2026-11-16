import { timestampMicros } from '../../src/role-eval/pending-time.js';
import type { SqlClient } from '../../src/role-eval/performance-postgres.js';

type Row = Record<string, unknown>;

const ident = String.raw`(?:\w+\.)?\w+`;

/** Executes the narrow SQL shape used by the Postgres store. Not a server. */
export class MemorySql implements SqlClient {
  private pendingSequence = 0n;
  private tables = new Map<string, Row[]>();
  private snapshot: Map<string, Row[]> | null = null;
  readonly advisoryLocks: unknown[][] = [];

  async transaction<T>(work: (query: SqlClient['query']) => Promise<T>): Promise<T> {
    await this.query('BEGIN');
    try {
      const result = await work((sql, params) => this.query(sql, params ?? []));
      await this.query('COMMIT');
      return result;
    } catch (error) {
      await this.query('ROLLBACK');
      throw error;
    }
  }

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    let compact = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE SEQUENCE IF NOT EXISTS front_claw_perf.pending_order_seq /.test(compact)) return { rows: [] };
    if (compact.startsWith("SELECT nextval('front_claw_perf.pending_order_seq')")) {
      const hours = this.rows('front_claw_perf.performance_config').find(r => r.key === params[0])?.value ?? null;
      return { rows: [{ sequence: String(++this.pendingSequence), hours }] as T[] };
    }
    const sequenceInsert = /jsonb_set\(\$(\d+)::jsonb,'\{([^}]+)\}',to_jsonb\(nextval\('front_claw_perf.pending_order_seq'\)::text\)\)::text/.exec(compact);
    if (sequenceInsert) {
      const next = [...params], index = Number(sequenceInsert[1]) - 1, payload = JSON.parse(String(next[index]));
      const path = sequenceInsert[2]!.split(',');
      if (path.length === 2) payload[path[0]!][path[1]!] = String(++this.pendingSequence);
      else payload[path[0]!] = String(++this.pendingSequence);
      // PG 的 jsonb::text 会改变空白/键序，不能假装保留 JSON.stringify 的原字节。
      next[index] = JSON.stringify(payload, null, 1); params = next;
      compact = compact.replace(sequenceInsert[0], `$${index + 1}::text`);
    }
    if (/^BEGIN$/i.test(compact)) {
      this.snapshot = new Map([...this.tables].map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
      return { rows: [] };
    }
    if (/^COMMIT$/i.test(compact)) { this.snapshot = null; return { rows: [] }; }
    if (/^ROLLBACK$/i.test(compact)) {
      if (this.snapshot) this.tables = this.snapshot;
      this.snapshot = null;
      return { rows: [] };
    }
    // M08：advisory lock 在单线程替身里无意义（真实锁由 PG 集成测试覆盖）；记录次数供断言。
    // M08：版本探测（to_regclass）——替身里按表是否存在回答；没有 schema_migrations = v7。
    const regclass = /^SELECT to_regclass\('([\w.]+)'\)::text AS ledger, to_regclass\('([\w.]+)'\)::text AS base$/i.exec(compact);
    if (regclass) return { rows: [{ ledger: this.tables.has(regclass[1]!) ? regclass[1] : null, base: this.tables.has(regclass[2]!) ? regclass[2] : null }] as T[] };
    if (/^SELECT pg_advisory_xact_lock\(\$1, \$2\)$/i.test(compact)) { this.advisoryLocks.push([...params]); return { rows: [] }; }
    if (/^CREATE SCHEMA\b/i.test(compact)) return { rows: [] };
    if (/^CREATE TABLE/i.test(compact)) {
      const name = new RegExp(String.raw`CREATE TABLE IF NOT EXISTS (${ident})`, 'i').exec(compact)?.[1];
      if (!name) throw Error(compact);
      if (!this.tables.has(name)) this.tables.set(name, []);
      return { rows: [] };
    }
    if (/^CREATE INDEX/i.test(compact)) return { rows: [] };
    // R3（A-P1-1）：统一入口的租约条件锁读 `SELECT c.key FROM <config> c WHERE c.key=$1 AND owner/epoch/until … FOR SHARE`。
    const leaseRead = new RegExp(String.raw`^SELECT c\.key FROM (${ident}) c WHERE c\.key=\$(\d+) AND .+?(?: FOR SHARE)?$`, 'i').exec(compact);
    if (leaseRead?.[1] && leaseRead[2]) return { rows: (this.leaseOk(leaseRead[1], params, Number(leaseRead[2]) - 1) ? [{ key: params[Number(leaseRead[2]) - 1] }] : []) as T[] };
    // R3：条件 INSERT `INSERT INTO t (cols) SELECT $1::text,… WHERE TRUE[ AND EXISTS(租约)] ON CONFLICT …` → 条件不成立不插入。
    const conditional = new RegExp(String.raw`^(INSERT INTO ${ident} \([^)]+\)) SELECT (.+?) WHERE TRUE(.*?)( ON CONFLICT .*)?$`, 'i').exec(compact);
    if (conditional?.[1] && conditional[2]) {
      const cond = conditional[3] ?? '';
      const exists = new RegExp(String.raw`^ AND EXISTS \(SELECT 1 FROM (${ident}) c WHERE c\.key=\$(\d+) AND .+\)$`, 'i').exec(cond);
      if (cond && !exists) throw Error(compact);
      if (exists?.[1] && exists[2] && !this.leaseOk(exists[1], params, Number(exists[2]) - 1)) return { rows: [] };
      const values = conditional[2].replace(/::text/g, '');
      return this.query(`${conditional[1]} VALUES (${values})${conditional[4] ?? ''}`, params);
    }
    if (/^INSERT /i.test(compact)) {
      // M05：INSERT … ON CONFLICT DO NOTHING RETURNING 与 PG 一致——冲突时不返回行。无 RETURNING 的旧语句行为不变。
      const returning = / RETURNING \w+$/i.test(compact);
      if (returning) {
        const sql = compact.replace(/ RETURNING \w+$/i, '');
        const before = this.tables.get(new RegExp(String.raw`^INSERT INTO (${ident})`, 'i').exec(sql)?.[1] ?? '')?.length ?? -1;
        const row = this.insert(sql, params);
        const after = this.tables.get(new RegExp(String.raw`^INSERT INTO (${ident})`, 'i').exec(sql)?.[1] ?? '')?.length ?? -1;
        // R3：ON CONFLICT DO UPDATE … RETURNING 在 PG 里插入或更新都返回该行。
        return { rows: (after > before || / DO UPDATE SET /i.test(sql) ? [row] : []) as T[] };
      }
      return { rows: [this.insert(compact, params)] as T[] };
    }
    if (/^SELECT /i.test(compact)) return { rows: this.select(compact, params) as T[] };
    if (/^UPDATE /i.test(compact)) return { rows: this.update(compact, params) as T[] };
    throw Error(`unsupported sql: ${compact}`);
  }

  /** R2/R3：租约行 owner/epoch 相等且 until > now（参数 k..k+3 = key, owner, epoch, now）。 */
  private leaseOk(configTable: string, params: readonly unknown[], k: number): boolean {
    const lease = this.rows(configTable).find(item => item.key === params[k]);
    const value = typeof lease?.value === 'string' ? lease.value : '';
    const owner = /"owner":"([^"\\]*)"/.exec(value)?.[1];
    const epoch = /"epoch":([0-9]{1,15})[,}]/.exec(value)?.[1];
    const until = /"until":([0-9]{1,16})[,}]/.exec(value)?.[1];
    return owner === params[k + 1] && epoch !== undefined && Number(epoch) === params[k + 2] && until !== undefined && Number(until) > Number(params[k + 3]);
  }

  private rows(table: string): Row[] {
    const found = this.tables.get(table);
    if (!found) {
      // R5：007 替身没有 store_targets（009 不在 MemorySql 上跑 ALTER）。首次读写时建空表。
      if (table === 'front_claw_perf.store_targets' || table.endsWith('.store_targets')) {
        const created: Row[] = [];
        this.tables.set(table, created);
        return created;
      }
      throw Error(`missing table ${table}`);
    }
    return found;
  }

  private insert(sql: string, params: readonly unknown[]): Row {
    const match = new RegExp(String.raw`^INSERT INTO (${ident}) \(([^)]+)\) VALUES \(([^)]+)\)(?: ON CONFLICT \(([^)]+)\) DO (NOTHING|UPDATE SET (.+)))?$`, 'i').exec(sql);
    if (!match || !match[1] || !match[2]) throw Error(sql);
    const table = this.rows(match[1]);
    const columns = match[2].split(',').map(column => column.trim());
    const row: Row = {};
    columns.forEach((column, index) => { row[column] = params[index]; });
    if (match[4]) {
      const keys = match[4].split(',').map(key => key.trim());
      const index = table.findIndex(existing => keys.every(key => existing[key] === row[key]));
      if (index >= 0) {
        if (match[5] === 'NOTHING') return { ...table[index] };
        const next = { ...table[index] };
        for (const assignment of match[6]?.matchAll(/(\w+)=EXCLUDED\.(\w+)/g) ?? []) {
          const column = assignment[1];
          const source = assignment[2];
          if (column && source) next[column] = row[source];
        }
        table[index] = next;
        return next;
      }
    }
    table.push(row);
    return row;
  }

  private select(sql: string, params: readonly unknown[]): Row[] {
    // M03: 行锁子句在单线程替身里无意义，忽略（真实锁序由 PG 集成测试覆盖）。
    sql = sql.replace(/\s+FOR (?:SHARE|UPDATE)(?: NOWAIT)?$/i, '');
    const match = new RegExp(String.raw`^SELECT \* FROM (${ident})(?: WHERE (.+))?$`, 'i').exec(sql);
    if (!match?.[1]) throw Error(sql);
    const table = this.rows(match[1]);
    if (!match[2]) return table.map(row => ({ ...row }));
    return table.filter(row => this.matches(match[2]!, params, row)).map(row => ({ ...row }));
  }

  private update(sql: string, params: readonly unknown[]): Row[] {
    const match = new RegExp(String.raw`^UPDATE (${ident}) SET (.+?) WHERE (.+?)(?: RETURNING .+)?$`, 'i').exec(sql);
    if (!match?.[1] || !match[2] || !match[3]) throw Error(sql);
    const table = this.rows(match[1]);
    const updated: Row[] = [];
    for (const row of table) {
      if (!this.matches(match[3], params, row)) continue;
      for (const assignment of match[2].matchAll(/(\w+)=\$(\d+)/g)) {
        const column = assignment[1];
        const index = assignment[2];
        if (column && index) row[column] = params[Number(index) - 1];
      }
      updated.push({ ...row });
    }
    return updated;
  }

  private matches(where: string, params: readonly unknown[], row: Row): boolean {
    // R2：条件更新里的租约 fence 子句（AND EXISTS (SELECT 1 FROM <config> c WHERE c.key=$k AND owner/epoch/until …)）。
    const exists = new RegExp(String.raw`\s+AND EXISTS \(SELECT 1 FROM (${ident}) c WHERE c\.key=\$(\d+) AND .+\)$`, 'i').exec(where);
    if (exists?.[1] && exists[2]) {
      const k = Number(exists[2]) - 1;
      const lease = this.rows(exists[1]).find(item => item.key === params[k]);
      const value = typeof lease?.value === 'string' ? lease.value : '';
      const owner = /"owner":"([^"\\]*)"/.exec(value)?.[1];
      const epoch = /"epoch":([0-9]{1,15})[,}]/.exec(value)?.[1];
      const until = /"until":([0-9]{1,16})[,}]/.exec(value)?.[1];
      const ok = owner === params[k + 1] && epoch !== undefined && Number(epoch) === params[k + 2] && until !== undefined && Number(until) > Number(params[k + 3]);
      return ok && this.matches(where.slice(0, exists.index), params, row);
    }
    const pending = / AND NOT EXISTS \(SELECT 1 FROM ([\w.]+) other WHERE other.reporter_person_id=\$(\d+) AND other.status='pending'\)/.exec(where);
    if (pending) {
      if (this.rows(pending[1]!).some(r => r.reporter_person_id === params[Number(pending[2]) - 1] && r.status === 'pending')) return false;
      where = where.replace(pending[0], '');
    }
    return where.split(/\s+AND\s+/i).every(clause => {
      const c = clause.trim();
      const prefix = /^starts_with\(key,\$(\d+)\)$/.exec(c);
      if (prefix) return String(row.key).startsWith(String(params[Number(prefix[1]) - 1]));
      const payloadEqual = /^payload_json::jsonb=\$(\d+)::jsonb$/.exec(c);
      if (payloadEqual) {
        const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, sorted(value)])) : v;
        return JSON.stringify(sorted(JSON.parse(String(row.payload_json)))) === JSON.stringify(sorted(JSON.parse(String(params[Number(payloadEqual[1]) - 1]))));
      }
      const order = /^\(payload_json::jsonb->'employeeContext'->>'pendingSequence'\)::bigint<\$(\d+)::bigint$/.exec(c);
      if (order) {
        const issued = JSON.parse(String(row.payload_json)).employeeContext?.pendingSequence;
        return issued !== undefined && BigInt(issued) < BigInt(String(params[Number(order[1]) - 1]));
      }
      const askOrder = /^\(value::jsonb->>'issuedSequence'\)::bigint<\$(\d+)::bigint$/.exec(c);
      if (askOrder) {
        const issued = JSON.parse(String(row.value)).issuedSequence;
        return issued !== undefined && BigInt(issued) < BigInt(String(params[Number(askOrder[1]) - 1]));
      }
      // R22：存储层时间条件，替身与 PG 的严格边界一致。
      const time = /^(?:(\w+)::timestamptz|\(value::jsonb->>'(expiresAt|issuedAt)'\)::timestamptz)(<=|<|>)\$(\d+)::timestamptz$/.exec(c);
      if (time) {
        const left = timestampMicros(String(time[1] ? row[time[1]] : JSON.parse(String(row.value))[time[2]!]));
        const right = timestampMicros(String(params[Number(time[4]) - 1]));
        return time[3] === '<=' ? left <= right : time[3] === '<' ? left < right : left > right;
      }
      // R2：通知状态 fence 条件（与 PG 同义）。
      const fence = /^COALESCE\(substring\((\w+) from .+\)::bigint, 0\) = \$(\d+)$/i.exec(c);
      if (fence?.[1] && fence[2]) return Number(/\|f=([0-9]{1,15})(?:\||$)/.exec(String(row[fence[1]]))?.[1] ?? 0) === params[Number(fence[2]) - 1];
      const part = /^split_part\((\w+), '\|', (\d)\) (=|>|IN) (.+)$/i.exec(c);
      if (part?.[1] && part[2] && part[3] && part[4]) {
        const v = String(row[part[1]]).split('|')[Number(part[2]) - 1] ?? '';
        const rhs = part[4].trim();
        if (part[3].toUpperCase() === 'IN') return [...rhs.matchAll(/'([^']*)'/g)].some(m => m[1] === v);
        const target = rhs.startsWith('$') ? String(params[Number(rhs.slice(1)) - 1]) : rhs.replace(/^'|'$/g, '');
        return part[3] === '=' ? v === target : v > target;
      }
      const distinct = /(\w+)\s+IS NOT DISTINCT FROM \$(\d+)/i.exec(c);
      if (distinct?.[1] && distinct[2]) {
        const left = row[distinct[1]];
        const right = params[Number(distinct[2]) - 1];
        return left === right || (left == null && right == null);
      }
      const match = /(\w+)=\$(\d+)/.exec(clause);
      if (!match?.[1] || !match[2]) throw Error(clause);
      return row[match[1]] === params[Number(match[2]) - 1];
    });
  }
}

/** R5：MemorySql 只跑 007（migratePerformance 不加 ALTER）。测试里补建 009 的 store_targets，避免查询缺表。 */
export const STORE_TARGETS_MEMORY_DDL = `CREATE TABLE IF NOT EXISTS front_claw_perf.store_targets (
  store_id text NOT NULL,
  period_month text NOT NULL,
  amount numeric(14,2) NOT NULL,
  set_by text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (store_id, period_month)
)`;
export async function applyMemoryR5(sql: MemorySql): Promise<void> {
  await sql.query(STORE_TARGETS_MEMORY_DDL);
}
