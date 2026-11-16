import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { command } from './process.mjs';
import { resolvePgTool } from './pg-tools.mjs';
import { provisionAccounts } from '../../dist/standalone/provision.js';
import { sqlClient, openRuntimeDatabase } from '../../dist/standalone/database.js';
import { migrateUp } from '../../dist/role-eval/schema-migrations.js';
import { seedSynthetic } from '../../dist/standalone/synthetic.js';
import { CONSUMER_LEASE_KEY } from '../../dist/opendot/consumer-lease.js';
import { parseLeaseRecord } from '../../dist/role-eval/fencing.js';

const assert = (condition, label) => { if (!condition) throw Object.assign(Error(label), { code: 'ASSERTION', assertion: label }); };
const schema = 'front_claw_perf';
const quote = value => '"' + value.replaceAll('"', '""') + '"';

async function connect(url, work) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try { await client.connect(); return await work(client); } finally { await client.end(); }
}
export async function snapshot(url) {
  return connect(url, async client => {
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema])).rows;
    const result = {};
    for (const { tablename } of tables) {
      const rows = (await client.query(`SELECT row_to_json(t)::text AS row FROM ${schema}.${quote(tablename)} t`)).rows.map(row => row.row).sort();
      result[tablename] = { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    }
    return result;
  });
}
function replacementDatabase(url, name) { const result = new URL(url); result.pathname = '/' + name; return result.href; }
async function denied(url, sql) {
  await connect(url, async client => {
    let code;
    await client.query('BEGIN');
    try { await client.query(sql); } catch (error) { code = error.code; }
    finally { await client.query('ROLLBACK'); }
    assert(code === '42501', 'permission_denial');
  });
}
async function message(env, text, messageId) {
  const response = await fetch(new URL('/message', env.CORE_URL), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, messageId }), signal: AbortSignal.timeout(25_000),
  });
  assert(response.ok, 'core_response');
  return response.json();
}
async function entryCount(url) {
  return connect(url, async client => Number((await client.query(`SELECT count(*) AS n FROM ${schema}.performance_entries`)).rows[0].n));
}
async function pgTool(env, tool, args, databaseUrl) {
  const url = new URL(databaseUrl);
  return command(await resolvePgTool(env, tool), ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), ...args], {
    env: { ...env, PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) },
  });
}

export async function runStep(step, env = process.env) {
  assert(env.AUDIT_PG_ALLOW === 'isolated-synthetic', 'isolated_approval');
  const admin = env.DATABASE_ADMIN_URL;
  assert(['pg', 'localhost', '127.0.0.1'].includes(new URL(admin).hostname), 'local_database');
  const artifacts = env.E2E_ARTIFACT_DIR;
  if (step === 'verify-consumer') {
    await connect(admin, async client => {
      const rows = (await client.query(`SELECT value FROM ${schema}.performance_config WHERE key=$1`, [CONSUMER_LEASE_KEY])).rows;
      if (rows.length) {
        const record = parseLeaseRecord(rows[0].value);
        assert(record && record.owner === null, 'consumer_lease_released');
      }
    });
    return { consumerAbsent: true };
  }
  if (step === 'initialize') {
    await connect(admin, async client => {
      assert((await client.query('SHOW server_version_num')).rows[0].server_version_num.startsWith('17'), 'pg17');
      assert((await client.query(`SELECT to_regnamespace($1) AS schema`, [schema])).rows[0].schema === null, 'fresh_database');
    });
    const pool = new pg.Pool({ connectionString: admin });
    try { assert((await migrateUp(sqlClient(pool), { apply: true })).to === 11, 'latest_migration'); } finally { await pool.end(); }
    await provision(env);
    const db = await openRuntimeDatabase(env.APP_DATABASE_URL);
    try {
      await seedSynthetic(db);
    } finally { await db.close(); }
    return { schemaVersion: 11, migrations: [7, 8, 9, 10, 11], people: 1 };
  }
  if (step === 'permissions') {
    await connect(env.READONLY_DATABASE_URL, client => client.query(`SELECT * FROM ${schema}.performance_people`));
    for (const sql of [
      `INSERT INTO ${schema}.performance_config (key,value) VALUES ('denied','denied')`,
      `UPDATE ${schema}.performance_people SET display_name='denied'`,
      `DELETE FROM ${schema}.performance_people`,
    ]) await denied(env.READONLY_DATABASE_URL, sql);
    for (const sql of [`CREATE TABLE ${schema}.denied (id int)`, `ALTER TABLE ${schema}.performance_people ADD COLUMN denied text`, 'CREATE TABLE public.denied (id int)']) await denied(env.APP_DATABASE_URL, sql);
    return { readonlyWriteDenied: 3, applicationDdlDenied: 3, readonlySelect: true };
  }
  if (step === 'flow') {
    const draft = await message(env, '12号测试店\n560（小赵）', 'synthetic-report');
    assert(draft.replies.join('\n').includes('560'), 'draft_reply');
    assert(await entryCount(admin) === 0, 'draft_no_entry');
    await connect(admin, async client => assert(Number((await client.query(`SELECT count(*) AS n FROM ${schema}.performance_drafts WHERE status='pending'`)).rows[0].n) === 1, 'pending_draft'));
    const confirmed = await message(env, '对', 'synthetic-confirm');
    assert(confirmed.replies.join('\n').includes('已入账') && confirmed.report.ledgerSettled === true, 'confirmed_reply');
    assert((await message(env, '12号测试店\n560（小赵）', 'synthetic-report')).replies.length === 0, 'report_no_duplicate_reply');
    assert((await message(env, '对', 'synthetic-confirm')).replies.length === 0, 'confirm_no_duplicate_reply');
    assert(await entryCount(admin) === 1, 'duplicate_single_entry');
    const progress = await message(env, '我本月业绩', 'synthetic-progress');
    assert(progress.replies.join('\n').includes('560'), 'progress_total');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await writeFile(path.join(artifacts, 'progress.json'), JSON.stringify(progress.replies), { mode: 0o600 });
    return { pendingBeforeConfirm: 1, entriesBeforeConfirm: 0, confirmedEntries: 1, replayEntries: 1, duplicateReplies: 0, progressContainsTotal: true };
  }
  if (step === 'model-flow') {
    const valid = await message(env, '合成模型 合法 560元', 'model-valid');
    assert(valid.replies.join('').includes('560') && valid.replies.join('').includes('对'), 'model_pending_reply');
    const pending = await connect(admin, async client => (await client.query(`SELECT draft_id,payload_json FROM ${schema}.performance_drafts WHERE status='pending'`)).rows);
    assert(pending.length === 1 && /^\d+$/.test(JSON.parse(pending[0].payload_json).employeeContext.pendingSequence), 'model_pending_sequence');
    await connect(env.APP_DATABASE_URL, async client => {
      await client.query('BEGIN');
      let code;
      try {
        await client.query(`INSERT INTO ${schema}.performance_drafts SELECT 'synthetic-collision',reporter_person_id,store_id,business_day,expires_at,kind,payload_json,status,reminder,void_notice,created_at,closed_at FROM ${schema}.performance_drafts WHERE draft_id=$1`, [pending[0].draft_id]);
      } catch (error) { code = error.code; }
      finally { await client.query('ROLLBACK'); }
      assert(code === '23505', 'pending_index_rejects_second_draft');
    });
    let asks = 0;
    for (const [index, kind] of ['坏JSON', '空回复', '超时', '限流', '错误'].entries()) {
      const result = await message(env, '合成模型 ' + kind, 'model-invalid-' + index);
      assert(result.replies.length === 1 && !result.replies.join('').includes('已入账'), 'model_fallback_ask');
      assert(await entryCount(admin) === 0, 'model_fallback_no_entry');
      await connect(admin, async client => {
        const rows = (await client.query(`SELECT draft_id FROM ${schema}.performance_drafts WHERE status='pending'`)).rows;
        assert(rows.length === 1 && rows[0].draft_id === pending[0].draft_id, 'model_shared_pending_slot');
      });
      asks++;
    }
    await connect(admin, async client => {
      const rows = (await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='performance_drafts_pending_reporter_unique'`, [schema])).rows;
      assert(rows.length === 1 && /UNIQUE/.test(rows[0].indexdef) && /pending/.test(rows[0].indexdef), 'pending_unique_index');
    });
    await message(env, '取消', 'model-cancel');
    return { validModelDrafts: 1, fallbackAsks: asks, ledgerEntries: 0, sharedPendingSlot: true, uniquePendingIndex: true };
  }
  if (step === 'replay') {
    assert((await message(env, '12号测试店\n560（小赵）', 'synthetic-report')).replies.length === 0, 'restart_report_no_reply');
    assert((await message(env, '对', 'synthetic-confirm')).replies.length === 0, 'restart_confirm_no_reply');
    await connect(admin, async client => {
      const rows = (await client.query(`SELECT value FROM ${schema}.performance_config WHERE key LIKE 'front-claw-op:%'`)).rows;
      assert(rows.some(row => { const record = JSON.parse(row.value); return record.messageId === 'synthetic-confirm' && record.state === 'completed' && record.ledgerSettled; }), 'pg_operation_record');
    });
    assert(await entryCount(admin) === 1, 'restart_single_entry');
    const progress = await message(env, '我本月业绩', 'synthetic-progress-after-restart');
    assert(JSON.stringify(progress.replies) === await readFile(path.join(artifacts, 'progress.json'), 'utf8'), 'restart_progress');
    return { restartedReplayEntries: 1, duplicateReplies: 0, persistedOperation: true, progressEqual: true };
  }
  if (step === 'backup') {
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const before = await snapshot(admin);
    await writeFile(path.join(artifacts, 'snapshot.json'), JSON.stringify(before), { mode: 0o600 });
    await pgTool(env, 'pg_dump', ['-Fc', '-f', path.join(artifacts, 'ledger.dump')], admin);
    return { tables: before, format: 'custom' };
  }
  if (step === 'restore') {
    await connect(admin, async client => { await client.query('CREATE DATABASE synthetic_restored'); });
    const restored = replacementDatabase(admin, 'synthetic_restored');
    await pgTool(env, 'pg_restore', ['--exit-on-error', '--dbname', 'synthetic_restored', path.join(artifacts, 'ledger.dump')], restored);
    const before = JSON.parse(await readFile(path.join(artifacts, 'snapshot.json'), 'utf8'));
    const after = await snapshot(restored);
    assert(JSON.stringify(before) === JSON.stringify(after), 'restored_checksums');
    return { tables: after, allCountsAndChecksumsEqual: true };
  }
  if (step === 'restored-progress') {
    const progress = await message(env, '我本月业绩', 'synthetic-progress-restored');
    assert(JSON.stringify(progress.replies) === await readFile(path.join(artifacts, 'progress.json'), 'utf8'), 'restored_progress');
    return { restoredProgressEqual: true };
  }
  throw Object.assign(Error('unknown_step'), { code: 'UNKNOWN_STEP' });
}

/** Reuse production account grants, keeping synthetic seeding in initialize only. */
export async function provision(env) {
  await connect(env.DATABASE_ADMIN_URL, async client => {
    await client.query('BEGIN');
    try {
      await provisionAccounts(async (sql, params) => ({ rows: (await client.query(sql, params ? [...params] : [])).rows }), env);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStep(process.argv[2]).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stdout.write(JSON.stringify({ error: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'STEP_FAILED', ...(error.assertion ? { assertion: error.assertion } : {}) }) + '\n');
    process.exitCode = 1;
  });
}
