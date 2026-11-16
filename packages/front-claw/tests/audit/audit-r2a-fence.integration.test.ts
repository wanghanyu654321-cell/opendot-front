import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { createNotificationDispatcher, NOTIFICATION_AUDIT_PREFIX, type DispatchEvent } from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus, encodeStatus } from '../../src/role-eval/notification-status.js';
import { gate, installPausePoints } from '../../src/role-eval/pause-points.js';
import { NOW } from '../role-eval/access-fixture-m03.js';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';

// Dispatcher must start PG17 externally. No cluster startup, file deletion, DROP or shared DB access here.
// AUDIT_PG_URL must be the disposable synthetic admin DB. New random audit DB retained for inspection.
const enabled=process.env.AUDIT_PG_ALLOW==='isolated-synthetic' && !!process.env.AUDIT_PG_URL;
it.skipIf(!enabled)('AUDIT f: paused A loses to B; stale begin and explicit mark both lost; only B sends', async()=>{
  const admin=new Client({connectionString:process.env.AUDIT_PG_URL!});await admin.connect();
  const name='audit_f_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${name}`);await admin.end();
  const u=new URL(process.env.AUDIT_PG_URL!);u.pathname='/'+name;
  const dbA=await openPerformanceStore({FRONT_CLAW_DATABASE_URL:u.toString()},{requirePostgres:true});
  const dbB=await openPerformanceStore({FRONT_CLAW_DATABASE_URL:u.toString()},{requirePostgres:true});
  const q=new Client({connectionString:u.toString()});await q.connect();
  const g=gate();let uninstall=()=>{};let task:Promise<unknown>|undefined;
  try {
    const catalog=await q.query(`SELECT a.atttypid::regtype::text AS type,c.collname,c.collisdeterministic FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation WHERE a.attrelid='front_claw_perf.performance_notifications'::regclass AND a.attname='status'`);
    expect(catalog.rows[0]).toMatchObject({type:'text',collisdeterministic:true});
    console.info(JSON.stringify({statusCatalog:catalog.rows}));
    const w=await worldM05({store:dbA.store});await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来');await w.call('m-zhao','对');
    const fa=fakeSender(),fb=fakeSender(),events:DispatchEvent[]=[];
    const later=new Date(NOW.getTime()+61000);let nowA=NOW;
    const A=createNotificationDispatcher({store:dbA.store,sender:fa.sender,now:()=>nowA,worker:'audit-A',leaseMs:60000,onEvent:e=>events.push(e)});
    const B=createNotificationDispatcher({store:dbB.store,sender:fb.sender,now:()=>later,worker:'audit-B',leaseMs:60000,onEvent:e=>events.push(e)});
    uninstall=installPausePoints({'send-gate:before-begin':g.hook});
    const ticking=A.tick();task=ticking;await g.reached;
    const aRow=(await dbA.store.listNotifications())[0]!, rawA=aRow.delivery!.raw;
    expect(decodeStatus(rawA).delivery.fence).toBe(1);
    uninstall();nowA=later;
    const b=await B.tick();expect(b).toMatchObject({sent:1,claimed:1});
    const rawB=(await dbB.store.listNotifications())[0]!.delivery!.raw;
    g.release();const a=await ticking;expect(a).toMatchObject({sent:0,lost:1});
    // Independent stale mark: old timestamp intentionally passes TS expiry precheck;
    // PG must reject stale raw/f even if caller clock is behind. This is not a second wire send.
    const mark=await dbA.store.transitionNotification(aRow.notificationId,rawA,encodeStatus('sent',{attempts:1,resends:0,fence:1}),NOW.toISOString(),{epoch:1,nowIso:NOW.toISOString()});
    expect(mark).toBe(false);
    expect((await dbA.store.listNotifications())[0]!.delivery!.raw).toBe(rawB);
    expect(fa.wire).toEqual([]);expect(fb.wire).toHaveLength(1);
    expect(events.filter(e=>e.type==='sent').map(e=>e.worker)).toEqual(['audit-B']);
    const audits=await q.query('SELECT key FROM front_claw_perf.performance_config WHERE key LIKE $1',[NOTIFICATION_AUDIT_PREFIX+'%']);
    expect(audits.rows).toEqual([]); // automatic sends emit events; persistent manual-requeue audit remains empty
    console.info(JSON.stringify({database:name,A:a,B:b,staleMark:mark,rawA,rawB,sentEvents:events.filter(e=>e.type==='sent'),manualAuditCount:audits.rowCount}));
  } finally { uninstall();g.release();await task?.catch(()=>{});await q.end();await dbA.close();await dbB.close(); }
},30000);
