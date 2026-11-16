// R2-5（D46）：用凭据文件启动 = 业务账号：不跑 DDL，只核对 schema 版本；连接串不进日志。pg 连接池用假实现（不联网）。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const SECRET = 'SYNTHETIC-PW-open-91';
const seen: { config: unknown[]; sql: string[] } = { config: [], sql: [] };
let version = 8;
vi.mock('../../src/role-eval/pg-pool.js', () => ({
  loadPgPool: async () => class {
    constructor(config: unknown) { seen.config.push(config); }
    async query(sql: string) {
      seen.sql.push(sql);
      if (/to_regclass/.test(sql)) return { rows: [{ ledger: version >= 8 ? 'front_claw_perf.schema_migrations' : null, base: version >= 7 ? 'front_claw_perf.performance_config' : null }] };
      if (/max\(version\)/.test(sql)) return { rows: [{ version }] };
      return { rows: [] };
    }
    async connect() { return { query: async (sql: string) => { seen.sql.push(sql); return { rows: [] }; }, release() {} }; }
    async end() {}
  },
}));
const { openPerformanceStore } = await import('../../src/role-eval/performance-open.js');
const { DATABASE_URL_FILE, resetCredentialCacheForTests } = await import('../../src/role-eval/credential-file.js');

const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'r2-open-'));
const path = join(dir, 'db-url'); writeFileSync(path, `postgres://fc_biz:${SECRET}@127.0.0.1:1/fc\n`, { mode: 0o600 }); chmodSync(path, 0o600);
const credentials = { readOnlyMount: () => true };
beforeEach(() => { seen.config.length = 0; seen.sql.length = 0; version = 8; resetCredentialCacheForTests(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('凭据文件启动：零 DDL（无 CREATE/ALTER/DROP/GRANT），只探测版本；schema < 7 → 固定错误码', async () => {
  const logs: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(k => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }));
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { logs.push(String(c)); return true; });
  try {
    const opened = await openPerformanceStore({ [DATABASE_URL_FILE]: path }, { requirePostgres: true, credentials });
    expect(opened.driver).toBe('postgres'); expect(opened.schemaVersion).toBe(8);
    expect(seen.sql.filter(s => /\b(CREATE|ALTER|DROP|GRANT|REVOKE)\b/i.test(s))).toEqual([]);
    expect(seen.config).toEqual([{ connectionString: `postgres://fc_biz:${SECRET}@127.0.0.1:1/fc` }]);
    await opened.close();
    version = 0; resetCredentialCacheForTests();
    await expect(openPerformanceStore({ [DATABASE_URL_FILE]: path }, { credentials })).rejects.toThrow('FRONT_CLAW_DATABASE_UNAVAILABLE_SCHEMA_TOO_OLD');
  } finally { spies.forEach(s => s.mockRestore()); write.mockRestore(); }
  expect(logs.join('\n')).not.toContain(SECRET);
});
it('对照：非生产直接 env 连接串仍走 007 基线（有 DDL）——说明零 DDL 只来自“文件 = 业务账号”这条规则', async () => {
  const opened = await openPerformanceStore({ FRONT_CLAW_DATABASE_URL: `postgres://dev:${SECRET}@127.0.0.1:1/fc` }, { credentials });
  expect(seen.sql.some(s => /\bCREATE\b/i.test(s))).toBe(true);
  await opened.close();
});
it('生产 + 直接 env 连接串 → 拒绝，且不建连接池', async () => {
  await expect(openPerformanceStore({ NODE_ENV: 'production', FRONT_CLAW_DATABASE_URL: `postgres://dev:${SECRET}@127.0.0.1:1/fc` }, { credentials })).rejects.toThrow('FRONT_CLAW_CREDENTIAL_ENV_URL_FORBIDDEN');
  expect(seen.config).toEqual([]);
});
