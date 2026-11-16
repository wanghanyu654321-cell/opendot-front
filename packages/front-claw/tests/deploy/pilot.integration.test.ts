import { expect, it } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runAdmin } from '../../src/standalone/admin.js';
import { createDatabasePool, sqlClient, openRuntimeDatabase } from '../../src/standalone/database.js';
import { migrateUp } from '../../src/role-eval/schema-migrations.js';
import { startFrontClawOpenDotService } from '../../src/opendot/index.js';
import { createOfflineChannel } from '../../src/standalone/offline.js';
import { EMPLOYEE_LOOP_CONFIG } from '../../src/role-eval/employee-loop.js';
import { ACCESS_POLICY_KEY } from '../../src/role-eval/access-policy.js';
import { dropIdleDatabase } from './isolated-database.js';

const approved = process.env.AUDIT_PG_ALLOW === 'isolated-synthetic' && !!process.env.AUDIT_PG_URL;
it.skipIf(!approved)('initializes a pilot twice without extra rows and resolves its binding through the adapter and employee loop', async () => {
  // The supplied URL must identify the reviewer's disposable local cluster. Never reuse an application database.
  const target = new URL(process.env.AUDIT_PG_URL!);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(target.hostname);
  expect(['postgres:', 'postgresql:']).toContain(target.protocol);
  const database = 'synthetic_pilot_' + randomUUID().replaceAll('-', '');
  const control = createDatabasePool(target.href, 1);
  let pool: pg.Pool | undefined;
  let service: Awaited<ReturnType<typeof startFrontClawOpenDotService>> | undefined;
  let closeRuntime: (() => Promise<void>) | undefined;
  let created = false;
  try {
    await control.query(`CREATE DATABASE "${database}"`); created = true;
    target.pathname = '/' + database;
    pool = createDatabasePool(target.href, 2);
    await migrateUp(sqlClient(pool), { apply: true });
    const environment = { DATABASE_ADMIN_URL: target.href, FRONT_CLAW_WECOM_BOT_ID: 'pilot-bot', PILOT_MEMBER_ID: 'pilot-member',
      PILOT_CORP_ID: 'pilot-corp', PILOT_DISPLAY_NAME: '小周', PILOT_STORE_ID: 'pilot-store', PILOT_STORE_NAME: '测试店', PILOT_ROLE: 'employee' };
    const snapshot = async () => {
      const tables = ['performance_people', 'wecom_bot_bindings', 'performance_config', 'performance_entries'];
      const result: Record<string, unknown> = {};
      for (const table of tables) result[table] = (await pool!.query(`SELECT to_jsonb(t) AS row FROM front_claw_perf.${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return result;
    };
    await expect(runAdmin('seed-pilot', environment)).resolves.toEqual({ pilotSeeded: true });
    const before = await snapshot();
    await runAdmin('seed-pilot', environment);
    expect(await snapshot()).toEqual(before);
    expect(before.performance_people).toHaveLength(1);
    expect(before.wecom_bot_bindings).toHaveLength(1);
    expect(before.performance_entries).toHaveLength(0);
    const configs = (await pool.query('SELECT key,value FROM front_claw_perf.performance_config WHERE key=ANY($1)', [[EMPLOYEE_LOOP_CONFIG, ACCESS_POLICY_KEY]])).rows;
    expect(JSON.parse(configs.find(row => row.key === EMPLOYEE_LOOP_CONFIG).value).memberIds).toEqual(['pilot-member']);

    const runtime = await openRuntimeDatabase(target.href);
    let closingRuntime: Promise<void> | undefined;
    closeRuntime = () => closingRuntime ??= runtime.close();
    const channel = createOfflineChannel();
    service = await startFrontClawOpenDotService({ env: { FRONT_CLAW_OPENDOT_ADAPTER: '1' }, logger: { info() {}, warn() {} } }, {
      open: async () => ({ ...runtime, close: closeRuntime! }), channel: () => channel, timers: false, now: () => new Date('2026-11-12T02:00:00Z'), owner: 'pilot-test-consumer',
    });
    channel.inject({ botId: 'pilot-bot', corpId: 'pilot-corp', memberId: 'pilot-member', messageId: 'pilot-report', reqId: 'pilot-report', text: '12号测试店\n380（小周）' });
    await service.idle();
    expect(service.stats().unbound).toBe(0);
    expect(channel.replies.join('')).toContain('对');
    expect((await runtime.store.listDrafts()).filter(draft => draft.status === 'pending')).toHaveLength(1);
    expect(await runtime.store.listEntries()).toHaveLength(0);
    channel.inject({ botId: 'pilot-bot', corpId: 'wrong-corp', memberId: 'pilot-member', messageId: 'wrong-corp', reqId: 'wrong-corp', text: '我的进度' });
    await service.idle();
    expect(service.stats().unbound).toBe(1);
  } finally {
    try { await service?.close(); }
    finally {
      try { await closeRuntime?.(); }
      finally {
        try { await pool?.end(); }
        finally {
          try { if (created) await dropIdleDatabase(control, database); }
          finally { await control.end(); }
        }
      }
    }
  }
}, 60_000);
