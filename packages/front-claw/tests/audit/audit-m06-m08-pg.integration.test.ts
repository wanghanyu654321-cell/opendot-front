import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { expect,it } from 'vitest';
import { decodeStatus,dueRaw } from '../../src/role-eval/notification-status.js';
const enabled=process.env.AUDIT_PG_ALLOW==='isolated-synthetic' && !!process.env.AUDIT_PG_URL;
// Port of all three old PG counterexamples: now both TS and 008 must reject. No permanent DB objects.
for(const raw of ['pending|','pending|2026-02-30T02:00:00.000Z|sending|a=1|r=0','unknown|-|-|a=99999999999|r=0'])
it.skipIf(!enabled)(`AUDIT 008 parity rejects ${raw}`,async()=>{
  const c=new Client({connectionString:process.env.AUDIT_PG_URL!});await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TEMP TABLE audit_delivery(status text,delivery_state text,delivery_phase text,delivery_attempts integer,delivery_resends integer,delivery_next_at timestamptz,delivery_lease_until timestamptz,delivery_lease_token text,delivery_lease_owner text,delivery_error text,delivery_due_at timestamptz,delivery_fence bigint)`);
    const sql=await readFile(new URL('../../migrations/008_front_claw_delivery.sql',import.meta.url),'utf8');
    const fn=sql.match(/CREATE OR REPLACE FUNCTION front_claw_perf\.notification_delivery_sync\(\)[\s\S]*?\$fn\$;/)![0];
    await c.query(fn.replace('front_claw_perf.notification_delivery_sync()','pg_temp.audit_delivery_sync()'));
    await c.query('CREATE TRIGGER audit_delivery_sync BEFORE INSERT OR UPDATE ON audit_delivery FOR EACH ROW EXECUTE FUNCTION pg_temp.audit_delivery_sync()');
    expect(decodeStatus(raw).delivery.error).toBe('malformed_status');
    expect(dueRaw(raw,'2026-11-12T02:00:00.000Z')).toBe(false);
    await expect(c.query('INSERT INTO audit_delivery(status) VALUES ($1)',[raw])).rejects.toMatchObject({code:'22023'});
  } finally {await c.query('ROLLBACK');await c.end();}
});
