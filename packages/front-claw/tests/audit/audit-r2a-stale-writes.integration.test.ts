import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect,it,vi } from 'vitest';
import { openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { startFrontClawOpenDotService } from '../../src/opendot/adapter.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { fakeHost,manualClock,offlineChannels,seedWorld } from '../opendot/fixture-m07.js';
const enabled=process.env.AUDIT_PG_ALLOW==='isolated-synthetic' && !!process.env.AUDIT_PG_URL;
// Expected-safe assertions: these should FAIL on 6fcd2765 if the independently observed residual reproduces on PG.
// Dispatcher starts isolated synthetic PG externally. This test creates/retains one audit DB per case, never drops or deletes.
for(const mode of ['create','cancel'] as const) it.skipIf(!enabled)(`AUDIT PG stale ${mode} must not write after takeover`,async()=>{
  const admin=new Client({connectionString:process.env.AUDIT_PG_URL!});await admin.connect();
  const name='audit_stale_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${name}`);await admin.end();
  const u=new URL(process.env.AUDIT_PG_URL!);u.pathname='/'+name;
  const A=await openPerformanceStore({FRONT_CLAW_DATABASE_URL:u.toString()},{requirePostgres:true});
  const B=await openPerformanceStore({FRONT_CLAW_DATABASE_URL:u.toString()},{requirePostgres:true});
  await seedWorld(A.store,A.bindings);const clock=manualClock(),ca=offlineChannels(),cb=offlineChannels();
  const a=await startFrontClawOpenDotService(fakeHost().host,{open:async()=>A,channel:ca.factory,now:clock.now,owner:'audit-A',timers:false});
  let hit!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{hit=r;}), wait=new Promise<void>(r=>{release=r;});
  const sheet='12号测试B店\n560（小赵）';
  if(mode==='cancel'){ca.send('m-zhao',sheet,'report');await a.idle();}
  let restore:()=>void;
  if(mode==='create'){
    const original=A.store.saveDraft.bind(A.store);
    const spy=vi.spyOn(A.store,'saveDraft').mockImplementationOnce(async(...args)=>{hit();await wait;return original(...args);});restore=()=>spy.mockRestore();
  }else{
    const original=A.store.transitionPendingDraft.bind(A.store);
    const spy=vi.spyOn(A.store,'transitionPendingDraft').mockImplementationOnce(async(...args)=>{hit();await wait;return original(...args);});restore=()=>spy.mockRestore();
  }
  ca.send('m-zhao',mode==='create'?sheet:'取消',mode);await reached;clock.advance(30001);
  const b=await startFrontClawOpenDotService(fakeHost().host,{open:async()=>B,channel:cb.factory,now:clock.now,owner:'audit-B',timers:false});
  try{
    expect(b.state()).toBe('active');const lease=await B.store.getConfig(CONSUMER_LEASE_KEY);
    const before=await B.store.listDrafts();release();await a.idle();const after=await B.store.listDrafts();
    console.info(JSON.stringify({database:name,mode,before:before.map(d=>d.status),after:after.map(d=>d.status),leaseUnchanged:lease===await B.store.getConfig(CONSUMER_LEASE_KEY)}));
    expect(after).toEqual(before);
  }finally{release();await a.idle();restore();await a.close();await b.close();}
},30000);
