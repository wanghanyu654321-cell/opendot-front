import {it, expect} from 'vitest';
import {Client, Pool} from 'pg';
import {spawn, type ChildProcess} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startFrontClawOpenDotService, type FrontClawOpenDotService} from '../../src/opendot/adapter.js';
import type {FrontClawChannel, InboundText} from '../../src/opendot/wecom-channel.js';
import {openPerformanceStore, readPerformanceMigration, type OpenedPerformanceStore} from '../../src/role-eval/performance-open.js';
import {createPostgresPerformanceStore, migratePerformance, type SqlClient} from '../../src/role-eval/performance-postgres.js';
import {createPostgresBindingStore} from '../../src/role-eval/directory-store.js';
import {openSql} from '../../src/migration/pg.js';
import {migrateUp} from '../../src/role-eval/schema-migrations.js';
import * as access from '../../src/role-eval/access-policy.js';
import {installPausePoints} from '../../src/role-eval/pause-points.js';
import {toPgNumeric, fromPgNumeric, yuanStringToCents} from '../../src/role-eval/money.js';
import type {PerformanceStore, Person} from '../../src/role-eval/performance-store.js';

type Row = Record<string, any>;
const deferred = () => {let release!: () => void; const promise = new Promise<void>(r=>{release=r;}); return {promise,release};};
async function bounded<T>(p: Promise<T>, ms=10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('test_deadline')),ms);})]);}
  finally {clearTimeout(timer);}
}
const errorOf = (e: unknown) => {
  const v=e as {code?:string;message?:string};
  return {sqlstate: /^[0-9A-Z]{5}$/.test(v?.code??'')?v.code:null,
    category: /^[a-z_]+$/.test(v?.message??'')?v.message:'captured_error'};
};
const echoCents=(text:string)=>yuanStringToCents(/共\s*([0-9.]+)元/.exec(text)?.[1]??'')??Number.NaN;
const hashLock=(v: string) => {let h=0;for(let i=0;i<v.length;i++)h=(Math.imul(h,31)+v.charCodeAt(i))|0;return h;};

const hasOwnedPg = process.env.APPEND_OWNED_PG === '1'
  && /^postgres:\/\/append_synthetic@localhost:55482$/.test(process.env.APPEND_PG_BASE ?? '');

it.skipIf(!hasOwnedPg)('APPEND: collect every synthetic PG scene and postcondition before asserting', async () => {
  const output=process.env.APPEND_EVIDENCE_DIR!;
  const runtime=process.env.APPEND_RUNTIME_DIR!;
  const base=process.env.APPEND_PG_BASE!;
  if(process.env.APPEND_OWNED_PG!=='1' || !/^postgres:\/\/append_synthetic@localhost:55482$/.test(base??''))throw Error('owned_pg_required');
  const world=await import(pathToFileURL(join(runtime,'synthetic.mjs')).href) as {
    BOT:string;CORP:string;STORE:string;NOW:string;DAY:string;people:Person[];
    seedSynthetic(o:OpenedPerformanceStore,m:typeof access):Promise<void>;
    sheet(amount?:string,customer?:string,owner?:string,note?:string):string;
  };
  const {BOT,CORP,STORE,NOW,DAY,people,sheet}=world;
  const employee=people[0]!,manager=people[1]!;
  const evidence: Row={schemaVersion:1,syntheticOnly:true,startedAt:new Date().toISOString(),
    scope:{adapter:'production',store:'production-postgres',channel:'controlled-fake',host:'test-port',fullHost:false,phoneReceipt:false},
    cases:[],checks:[],errors:[]};
  let sequence=0;
  const mark=(list:Row[],event:string,extra:Row={})=>list.push({event,at:Date.now(),monotonic:performance.now(),...extra});
  const check=(id:string,passed:boolean,actual:unknown,expected:unknown,classification='blocking')=>evidence.checks.push({id,passed:Boolean(passed),actual,expected,classification});
  async function phase(record:Row,name:string,fn:()=>Promise<any>){
    try {const value=await fn();return value;}
    catch(e){record.errors.push({phase:name,...errorOf(e)});return undefined;}
  }
  async function raw(url:string){const c=new Client({connectionString:url,host:'localhost',connectionTimeoutMillis:2000,query_timeout:8000});await c.connect();return c;}
  async function query(url:string,sql:string,params:unknown[]=[]){const c=await raw(url);try{return(await c.query(sql,params)).rows;}finally{await c.end();}}
  async function fresh(){
    const db=`append_synthetic_${++sequence}`;
    await query(base+'/postgres',`CREATE DATABASE ${db}`);
    const url=base+'/'+db;
    const migration=await openSql(url);
    try{await migratePerformance(migration.client,readPerformanceMigration());await migrateUp(migration.client,{apply:true});}finally{await migration.close();}
    const opened=await openPerformanceStore({FRONT_CLAW_DATABASE_URL:url},{requirePostgres:true});
    try{await world.seedSynthetic(opened,access);}finally{await opened.close();}
    return url;
  }
  async function snapshot(url:string){
    const rows=await query(url,`SELECT entry_id,source_draft_id,source_ordinal,amount::text AS amount,owner_person_id,customer_name,note,status,reporter_person_id FROM front_claw_perf.performance_entries ORDER BY entry_id`);
    const drafts=await query(url,`SELECT draft_id,reporter_person_id,status,payload_json::jsonb AS payload FROM front_claw_perf.performance_drafts ORDER BY draft_id`);
    const totals=(await query(url,`SELECT count(*)::int AS count,coalesce(sum(amount),0)::text AS total FROM front_claw_perf.performance_entries WHERE status='confirmed'`))[0];
    return {rows,drafts,totals,sourceCounts:drafts.map(d=>({draftId:d.draft_id,reporter:d.reporter_person_id,count:rows.filter(r=>r.source_draft_id===d.draft_id).length}))};
  }
  function fakeChannel(onReply?: (event:InboundText)=>Promise<void>){
    let receiver:((event:InboundText)=>void)|undefined;
    const replies:Row[]=[];
    const channel:FrontClawChannel={open(fn){receiver=fn;},ready:()=>true,current:()=>true,rejected:()=>0,async close(){},
      notify:async()=>({state:'blocked',apiErrorCode:null,msgid:null,detail:'synthetic_disabled'}),
      async reply(event,text){replies.push({memberId:event.memberId,messageId:event.messageId,text,ack:'synthetic-accepted',at:Date.now()});await onReply?.(event);return 'accepted';}};
    return {channel,replies,send(memberId:string,text:string,messageId:string){receiver!({reqId:`req-${messageId}`,botId:BOT,corpId:CORP,memberId,messageId,text});}};
  }
  async function adapter(opened:OpenedPerformanceStore, channel:FrontClawChannel){
    return startFrontClawOpenDotService({env:{FRONT_CLAW_OPENDOT_ADAPTER:'1'},logger:{info(){},warn(){}}},{
      open:async()=>opened,channel:()=>channel,now:()=>new Date(NOW),owner:'append-synthetic-owner',timers:false,requestTimeoutMs:20000});
  }
  async function waitLocks(url:string,minimum:number,pids?:number[]){
    const deadline=Date.now()+3000;
    for(;;){
      const rows=await query(url,`SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ($1::int[] IS NULL OR pid=ANY($1::int[]))`,[pids??null]);
      if(rows.length>=minimum)return rows;
      if(Date.now()>deadline)throw Error('lock_wait_not_observed');
      await new Promise(r=>setTimeout(r,15));
    }
  }
  const variants=[
    {id:'same-integer',a:sheet('560'),b:sheet('560'),rows:1,total:56000},
    {id:'same-decimal-representation',a:sheet('560.0'),b:sheet('560.00'),rows:1,total:56000},
    {id:'same-fraction-representation',a:sheet('560.5'),b:sheet('560.50'),rows:1,total:56050},
    {id:'same-cent-representation',a:sheet('560.05'),b:sheet('560.05'),rows:1,total:56005},
    {id:'different-amount',a:sheet('560'),b:sheet('561'),rows:2,total:112100},
    {id:'different-customer',a:sheet('560','韩姐'),b:sheet('560','冯姐'),rows:2,total:112000},
    {id:'different-owner',a:sheet('560'),b:sheet('560','','合成员乙'),rows:2,total:112000},
    {id:'same-customer-different-amount',a:sheet('560','韩姐'),b:sheet('560.01','韩姐'),rows:2,total:112001},
    {id:'multiset-two-lines',a:sheet('560')+'\n560（合成员甲）',b:sheet('560'),rows:2,total:112000},
  ];
  try {
    for(const variant of variants){
      const record:Row={family:'concurrency',id:variant.id,errors:[],timeline:[],expected:{rows:variant.rows,totalCents:variant.total}};evidence.cases.push(record);
      let url:string|undefined,service:FrontClawOpenDotService|undefined,opened:OpenedPerformanceStore|undefined,blocker:Client|undefined;
      const release=deferred(),both=deferred();let uninstall:(()=>void)|undefined;let arrived=0;
      await phase(record,'scenario',async()=>{
        url=await fresh();opened=await openPerformanceStore({FRONT_CLAW_DATABASE_URL:url},{requirePostgres:true});
        record.commitCalls=[];
        const store=new Proxy(opened.store,{get(target,key){const value=Reflect.get(target,key);if(key==='commitConfirmingDraft')return async(...args:Parameters<PerformanceStore['commitConfirmingDraft']>)=>{
          const [draft,entries]=args;
          mark(record.timeline,'commit_call',{draftId:draft.draftId,reporter:draft.reporterPersonId});
          record.commitCalls.push({draftId:draft.draftId,reporter:draft.reporterPersonId,entries:entries.map(e=>({owner:e.ownerPersonId,amountCents:e.amount,pgNumeric:toPgNumeric(e.amount),customer:e.customerName,note:e.note,sourceDraftId:e.sourceDraftId,sourceOrdinal:e.sourceOrdinal}))});
          try{const result=await target.commitConfirmingDraft(...args);mark(record.timeline,'commit_return',{draftId:draft.draftId,result});return result;}
          catch(e){mark(record.timeline,'commit_error',{draftId:draft.draftId,...errorOf(e)});throw e;}
        };return typeof value==='function'?value.bind(target):value;}});
        const ch=fakeChannel();record.replies=ch.replies;
        service=await adapter({...opened,store},ch.channel);
        const makeDraft=async(actor:Person,text:string,id:string)=>{
          ch.send(actor.memberId,text,id);await bounded(service!.idle());
          if(/是新客户/.test(String(ch.replies.at(-1)?.text??''))){
            ch.send(actor.memberId,'是',id+'-customer-yes');await bounded(service!.idle());
          }
        };
        await makeDraft(employee,variant.a,'append-synthetic-employee-draft');
        await makeDraft(manager,variant.b,'append-synthetic-manager-draft');
        record.before=await snapshot(url);
        blocker=await raw(url);await blocker.query('SELECT pg_advisory_lock($1,$2)',[hashLock(STORE),hashLock(DAY)]);
        uninstall=installPausePoints({'commit-gate:before-commit':async({id})=>{mark(record.timeline,'before_commit_barrier',{draftId:id});if(++arrived===2)both.release();await release.promise;}});
        ch.send(employee.memberId,'对','append-synthetic-employee-confirm');ch.send(manager.memberId,'对','append-synthetic-manager-confirm');
        await bounded(both.promise,5000);mark(record.timeline,'barrier_both_reached');release.release();
        record.lockWait=await waitLocks(url,2);
        if(!record.lockWait.every((r:Row)=>r.wait_event==='advisory'))throw Error('advisory_wait_not_observed');mark(record.timeline,'two_lock_waiters_observed',{waiters:record.lockWait});
        await blocker.query('SELECT pg_advisory_unlock($1,$2)',[hashLock(STORE),hashLock(DAY)]);mark(record.timeline,'external_advisory_lock_released');
        await bounded(service.idle());
        record.constraints=await query(url,`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='front_claw_perf.performance_entries'::regclass ORDER BY conname`);
        record.indexes=await query(url,`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='front_claw_perf' AND tablename='performance_entries' ORDER BY indexname`);
        record.numeric=await query(url,`SELECT v::numeric(14,2)::text AS stored FROM (VALUES ('560'),('560.0'),('560.00'),('560.50'),('560.05')) x(v)`);
      });
      // Always release barriers/locks BEFORE waiting or collecting final postconditions.
      release.release();uninstall?.();
      if(blocker)await phase(record,'unlock',()=>blocker!.query('SELECT pg_advisory_unlock_all()'));
      if(service)await phase(record,'drain',()=>bounded(service!.idle(),23000));
      if(url)await phase(record,'postconditions',async()=>{record.after=await snapshot(url!);
        record.normalization=record.after.rows.map((r:Row)=>({amount:r.amount,pgType:typeof r.amount,cents:fromPgNumeric(r.amount),candidate:toPgNumeric(fromPgNumeric(r.amount)),
          rawKey:JSON.stringify([r.owner_person_id,String(r.amount),r.customer_name,r.note]),
          candidateKey:JSON.stringify([r.owner_person_id,toPgNumeric(fromPgNumeric(r.amount)),r.customer_name,r.note]),
          normalizedKey:JSON.stringify([r.owner_person_id,fromPgNumeric(r.amount),r.customer_name,r.note])}));});
      if(blocker)await phase(record,'blocker_close',()=>blocker!.end());
      if(service)await phase(record,'service_close',()=>service!.close());else if(opened)await phase(record,'store_close',()=>opened!.close());
      check(variant.id+':actions',record.errors.length===0,record.errors,[]);
      check(variant.id+':ledger-rows',record.after?.totals.count===variant.rows,record.after?.totals.count,variant.rows);
      check(variant.id+':ledger-total',record.after && fromPgNumeric(record.after.totals.total)===variant.total,record.after?.totals.total,variant.total);
      const confirmations=(record.replies??[]).filter((r:Row)=>r.messageId.endsWith('-confirm'));
      const echoedRows=confirmations.reduce((sum:number,r:Row)=>sum+Number(/已入账\s*(\d+)\s*笔/.exec(r.text)?.[1]??NaN),0);
      check(variant.id+':both-confirmation-replies',confirmations.length===2,confirmations.length,2);
      check(variant.id+':echoed-rows',echoedRows===variant.rows,echoedRows,variant.rows);
      check(variant.id+':two-drafts',record.after?.sourceCounts.length===2,record.after?.sourceCounts.length,2);
      const echoedTotal=confirmations.reduce((sum:number,r:Row)=>sum+echoCents(r.text),0);
      check(variant.id+':echoed-total',echoedTotal===variant.total,echoedTotal,variant.total);
      const sources=(record.after?.sourceCounts??[]).map((source:Row)=>{
        const call=record.commitCalls.find((c:Row)=>c.draftId===source.draftId);
        const member=people.find(p=>p.personId===source.reporter)?.memberId;
        const reply=confirmations.find((r:Row)=>r.memberId===member);
        const actual=record.after.rows.filter((r:Row)=>r.source_draft_id===source.draftId);
        const payload=record.after.drafts.find((d:Row)=>d.draft_id===source.draftId);
        return {draftId:source.draftId,count:source.count,candidates:call?.entries.length,
          echoed:Number(/已入账\s*(\d+)\s*笔/.exec(reply?.text??'')?.[1]??NaN),
          echoedCents:echoCents(reply?.text??''),
          actualCents:actual.reduce((n:number,r:Row)=>n+fromPgNumeric(r.amount),0),
          settled:payload?.status==='confirmed' && payload?.payload.employeeContext?.finalReply===reply?.text};
      });
      check(variant.id+':source-count-and-echo',sources.length===2 && sources.every((r:Row)=>r.count<=r.candidates && r.count===r.echoed && r.echoedCents===r.actualCents),sources,'each source count and amount equals its own echo');
      check(variant.id+':persisted-final-reply',sources.length===2 && sources.every((r:Row)=>r.settled),sources,'both confirmed final replies equal durable payload');
      const sourceKeys=(record.after?.rows??[]).map((r:Row)=>JSON.stringify([r.source_draft_id,r.source_ordinal]));
      check(variant.id+':unique-source-ordinals',new Set(sourceKeys).size===variant.rows,sourceKeys,'one persisted row per source ordinal');
    }

    // Synthetic reverse aggregate: production savePerson/saveBinding + updateConfigLocked
    // composed on one test-owned transaction; no claim that a production aggregate API exists.
    for(const resource of ['binding','people'] as const)for(const first of ['commit','reverse'] as const){
      const record:Row={family:'reverse-lock',id:`${resource}-${first}-first`,errors:[],timeline:[],settings:[],boundary:'test-composed reverse aggregate; actual production transaction methods executed'};evidence.cases.push(record);
      let url:string|undefined,service:FrontClawOpenDotService|undefined,opened:OpenedPerformanceStore|undefined,pool:Pool|undefined,reverse:Client|undefined;
      let reverseWork:Promise<void>|undefined,reverseFinished=false,commitActive=false,paused=false;const heldConfig=deferred(),proceed=deferred(),commitDone=deferred();
      const outcome=(actor:string,result:unknown)=>mark(record.timeline,'outcome',{actor,result});
      await phase(record,'scenario',async()=>{
        url=await fresh();pool=new Pool({connectionString:url,host:'localhost',max:4,connectionTimeoutMillis:2000,query_timeout:8000});
        const settings=async(q:(sql:string)=>Promise<unknown>,who:string)=>{
          await q("SET LOCAL lock_timeout='2500ms'");await q("SET LOCAL statement_timeout='6000ms'");await q('SAVEPOINT append_settings');
          try{await q("SET LOCAL deadlock_timeout='100ms'");record.settings.push({who,deadlockTimeout:'100ms'});}
          catch(e){record.settings.push({who,...errorOf(e)});await q('ROLLBACK TO SAVEPOINT append_settings');}
          await q('RELEASE SAVEPOINT append_settings');
        };
        const sql:SqlClient={query:async(text,params)=>({rows:(await pool!.query(text,params?[...params]:[])).rows}),
          async transaction(work){const c=await pool!.connect();try{
            await c.query('BEGIN');await settings(s=>c.query(s),'commit-side');
            const active=commitActive;
            if(active)record.commitPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const q:SqlClient['query']=async(text,params)=>{
              const rows=(await c.query(text,params?[...params]:[])).rows;
              if(active)mark(record.timeline,'commit_sql_completed',{kind:text.includes('performance_config')?'config':text.includes('performance_people')?'people':text.includes('wecom_bot_bindings')?'binding':text.startsWith('SELECT pg_advisory')?'advisory':'business',lock:/FOR SHARE/.test(text)?'share':null});
              if(active && first==='commit' && !paused && text.includes('performance_config') && /FOR SHARE/.test(text) && params?.[0]===access.ACCESS_POLICY_KEY){paused=true;heldConfig.release();await proceed.promise;}
              return {rows};
            };
            const result=await work(q);await c.query('COMMIT');return result;
          }catch(e){if(commitActive)record.commitError=errorOf(e);await c.query('ROLLBACK');if(commitActive)record.commitRolledBack=true;throw e;}finally{c.release();}}
        };
        const realStore=createPostgresPerformanceStore(sql,{deliveryColumns:true});
        const store=new Proxy(realStore,{get(target,key){const value=Reflect.get(target,key);if(key==='commitConfirmingDraft')return async(...args:Parameters<PerformanceStore['commitConfirmingDraft']>)=>{
          commitActive=true;try{const r=await target.commitConfirmingDraft(...args);record.commitResult=r;record.commitOutcome='success-or-denial';outcome('commit',r);return r;}catch(e){record.commitRejection={...errorOf(e),name:(e as Error).name};record.commitOutcome=(e as Error).name==='CommitContentionRejected'?'safe-refusal':'error';outcome('commit',record.commitOutcome);throw e;}finally{commitActive=false;commitDone.release();}
        };return typeof value==='function'?value.bind(target):value;}});
        opened={store,bindings:createPostgresBindingStore(sql),driver:'postgres',schemaVersion:11,close:()=>pool!.end()};
        const ch=fakeChannel();record.replies=ch.replies;service=await adapter(opened,ch.channel);
        ch.send(employee.memberId,sheet(),'append-synthetic-lock-draft');await bounded(service.idle());
        reverse=await raw(url);await reverse.query('BEGIN');await settings(s=>reverse!.query(s),'reverse-side');
        record.reversePid=(await reverse.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const rq:SqlClient['query']=async(text,params)=>({rows:(await reverse!.query(text,params?[...params]:[])).rows});
        const reverseSql:SqlClient={query:rq,transaction:work=>work(rq)};
        const revStore=createPostgresPerformanceStore(reverseSql),bindings=createPostgresBindingStore(reverseSql);
        const acquireResource=async()=>{
          if(resource==='binding')await bindings.saveBinding({botId:BOT,corpId:CORP,memberId:employee.memberId,accountId:employee.accountId,version:2,active:false});
          else await revStore.savePerson({...employee,active:false});
          mark(record.timeline,'reverse_resource_held',{resource});
        };
        if(first==='reverse')await acquireResource();
        ch.send(employee.memberId,'对','append-synthetic-lock-confirm');
        if(first==='commit'){await bounded(heldConfig.promise,5000);mark(record.timeline,'commit_config_held');await acquireResource();}
        else {await bounded(commitDone.promise,5000);mark(record.timeline,'commit_resource_nowait_refused');}
        reverseWork=(async()=>{try{
          mark(record.timeline,'reverse_config_attempt');
          await revStore.updateConfigLocked(access.ACCESS_POLICY_KEY,[],current=>({[access.ACCESS_POLICY_KEY]:current[access.ACCESS_POLICY_KEY]!}));
          await reverse!.query('COMMIT');record.reverseOutcome='committed';outcome('reverse','committed');
        }catch(e){record.reverseOutcome=errorOf(e);outcome('reverse',record.reverseOutcome);await reverse!.query('ROLLBACK').catch(()=>{});}finally{reverseFinished=true;}})();
        if(first==='commit'){record.reverseWait=await waitLocks(url!,1,[record.reversePid]);mark(record.timeline,'reverse_config_wait_observed',{waiters:record.reverseWait});}
        proceed.release();await bounded(Promise.all([reverseWork,service.idle()]),18000);
      });
      proceed.release();
      if(reverse && !reverseFinished)await phase(record,'reverse_rollback',()=>reverse!.query('ROLLBACK'));
      if(reverseWork)await phase(record,'reverse_settle',()=>bounded(reverseWork!,9000));
      if(service)await phase(record,'drain',()=>bounded(service!.idle(),23000));
      if(url)await phase(record,'postconditions',async()=>{record.after=await snapshot(url!);
        record.binding=await query(url!,`SELECT active,version FROM front_claw_perf.wecom_bot_bindings WHERE bot_id=$1 AND member_id=$2`,[BOT,employee.memberId]);
        record.person=await query(url!,`SELECT active FROM front_claw_perf.performance_people WHERE person_id=$1`,[employee.personId]);});
      if(reverse)await phase(record,'reverse_close',()=>reverse!.end());
      if(service)await phase(record,'service_close',()=>service!.close());else if(pool)await phase(record,'pool_close',()=>pool!.end());
      check(record.id+':actions',record.errors.length===0,record.errors,[]);
      const codes=[record.commitError?.sqlstate,record.reverseOutcome?.sqlstate].filter(Boolean);
      // Legal new semantics: only the commit guard's classified NOWAIT refusal is accepted.
      // Deadlocks, cancellation and reverse-side lock timeouts remain failures.
      record.classification={commit:record.commitOutcome,commitSqlstate:record.commitError?.sqlstate??null,reverse:record.reverseOutcome};
      check(record.id+':no-deadlock-or-timeout',codes.every(c=>c==='55P03') && record.reverseOutcome==='committed',codes,'commit 55P03 only; reverse committed');
      check(record.id+':classified-safe-refusal',record.commitOutcome==='safe-refusal' && record.commitRejection?.sqlstate==='55P03' && record.commitRolledBack===true,record.classification,'guard NOWAIT refusal after rollback');
      check(record.id+':reverse-revocation-committed',record.reverseOutcome==='committed' && (resource==='binding'?record.binding?.[0]?.active===false:record.person?.[0]?.active===false),{binding:record.binding,person:record.person},'revoked');
      check(record.id+':no-success-echo',!(record.replies??[]).some((r:Row)=>r.messageId==='append-synthetic-lock-confirm' && /已入账/.test(r.text)),record.replies,'no committed echo');
      check(record.id+':rolled-back-draft',record.after?.drafts.length===1 && record.after.drafts[0]?.status==='confirming' && !record.after.drafts[0]?.payload.employeeContext?.finalReply,record.after?.drafts,'claim remains confirming; business settlement was rolled back');
      check(record.id+':zero-source-rows',record.after?.sourceCounts.every((r:Row)=>r.count===0) && record.after?.totals.count===0,record.after?.sourceCounts,'zero writes and no retry');
      check(record.id+':bounded-ledger',record.after && record.after.totals.count<=1,record.after?.totals.count,'0 or 1');
      check(record.id+':accounting-consistent',record.after && ((record.commitResult===1 && record.after.totals.count===1)||(record.commitResult!==1 && record.after.totals.count===0)),{result:record.commitResult,rows:record.after?.totals.count},'committed iff one row');
    }

    const crash:Row={family:'process-crash',id:'ack-before-final-persist',errors:[],timeline:[]};evidence.cases.push(crash);
    let crashUrl:string|undefined;const children:{child:ChildProcess;exit:Promise<Row>;exited:boolean}[]=[];
    const sendLog=join(output,'synthetic-sends.jsonl');
    async function child(mode:'crash'|'recover'){
      const cp=spawn(process.execPath,['--import',join(runtime,'network-guard.mjs'),join(runtime,'crash-worker.mjs'),process.env.APPEND_DIST!,crashUrl!,mode,sendLog],{
        cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME!,NODE_ENV:'test'},stdio:['ignore','ignore','ignore','ipc']});
      const messages:Row[]=[];let failure:Row|undefined;
      const owned={child:cp,exited:false,exit:Promise.resolve({}) as Promise<Row>};
      owned.exit=new Promise(resolve=>{cp.once('error',e=>{failure=errorOf(e);owned.exited=true;resolve({error:failure});});cp.once('exit',(code,signal)=>{owned.exited=true;const r={code,signal};mark(crash.timeline,'child_exit',{mode,pid:cp.pid,...r});resolve(r);});});children.push(owned);
      cp.on('message',(m:Row)=>{messages.push(m);mark(crash.timeline,'child_message',{mode,...m});});
      return {owned,messages,async wait(event:string){const deadline=Date.now()+15000;for(;;){const m=messages.find(m=>m.event===event);if(m)return m;if(failure||owned.exited||messages.some(m=>m.event==='worker_error'))throw Error('child_failed_before_barrier');if(Date.now()>deadline)throw Error('child_barrier_deadline');await new Promise(r=>setTimeout(r,20));}}};
    }
    await phase(crash,'scenario',async()=>{
      crashUrl=await fresh();await writeFile(sendLog,'');const a=await child('crash');
      crash.barrier=await a.wait('before_final_persist');
      crash.beforeKill=await snapshot(crashUrl);crash.operationBefore=(await query(crashUrl,`SELECT value::jsonb AS record FROM front_claw_perf.performance_config WHERE starts_with(key,'front-claw-op:') ORDER BY key`)).map(r=>r.record);
      mark(crash.timeline,'kill_exact_spawned_child',{pid:a.owned.child.pid,signal:'SIGKILL'});
      if(a.owned.exited)throw Error('child_exited_before_kill');
      if(!a.owned.child.kill('SIGKILL'))throw Error('owned_child_kill_failed');
      crash.killedExit=await bounded(a.owned.exit,5000);
      crash.afterKill=await snapshot(crashUrl);
      const b=await child('recover');crash.recovered=await b.wait('recovered_after');await b.wait('done');crash.recoveryExit=await bounded(b.owned.exit,5000);
      crash.operationAfter=(await query(crashUrl,`SELECT value::jsonb AS record FROM front_claw_perf.performance_config WHERE starts_with(key,'front-claw-op:') ORDER BY key`)).map(r=>r.record);
    });
    // Only ChildProcess handles returned by our own spawn are ever signalled.
    for(const owned of children)if(!owned.exited)await phase(crash,'owned_child_cleanup',async()=>{owned.child.kill('SIGKILL');await bounded(owned.exit,5000);});
    if(crashUrl)await phase(crash,'postconditions',async()=>{crash.after=await snapshot(crashUrl!);});
    await phase(crash,'send_evidence',async()=>{crash.sends=(await readFile(sendLog,'utf8')).trim().split('\n').filter(Boolean).map(v=>JSON.parse(v));});
    check('crash:actions',crash.errors.length===0,crash.errors,[]);
    check('crash:barrier-after-accepted',crash.barrier?.attempted.replyState==='accepted' && crash.timeline.some((r:Row)=>r.event==='fake_ack'),crash.barrier?.attempted,'fake ACK returned; accepted final save not invoked');
    check('crash:ledger-before-kill',crash.beforeKill?.totals.count===1,crash.beforeKill?.totals,1);
    check('crash:unknown-before-kill',crash.operationBefore?.some((r:Row)=>r.messageId==='append-synthetic-crash-confirm' && r.replyState==='unknown'),crash.operationBefore,'durable unknown before kill');
    check('crash:recovery-exit',crash.recoveryExit?.code===0,crash.recoveryExit,0);
    check('crash:real-sigkill',crash.killedExit?.signal==='SIGKILL',crash.killedExit,'SIGKILL');
    check('crash:ledger-once',crash.after?.totals.count===1 && fromPgNumeric(crash.after.totals.total)===56000,crash.after?.totals,{count:1,total:'560.00'});
    check('crash:fake-confirm-send-once',crash.sends?.filter((r:Row)=>r.messageId==='append-synthetic-crash-confirm').length===1,crash.sends?.length,'one draft reply and one confirmation reply');
    check('crash:no-replay-send',crash.sends?.filter((r:Row)=>r.mode==='recover').length===0,crash.sends?.filter((r:Row)=>r.mode==='recover').length,0);
    check('crash:durable-unknown',crash.recovered?.report.replyState==='unknown',crash.recovered?.report,'replyState unknown; no automatic retry');

    const boundary:Row={family:'handoff-boundary',id:'revoke-after-send-handoff',errors:[],timeline:[],classification:'observation-only'};evidence.cases.push(boundary);
    let boundaryUrl:string|undefined,boundaryService:FrontClawOpenDotService|undefined;
    await phase(boundary,'scenario',async()=>{
      boundaryUrl=await fresh();const o=await openPerformanceStore({FRONT_CLAW_DATABASE_URL:boundaryUrl},{requirePostgres:true});
      const ch=fakeChannel(async event=>{if(event.messageId==='append-synthetic-boundary-confirm'){
        mark(boundary.timeline,'fake_send_handoff');await o.bindings.saveBinding({botId:BOT,corpId:CORP,memberId:employee.memberId,accountId:employee.accountId,version:2,active:false});mark(boundary.timeline,'binding_revoked_after_handoff');}});
      boundaryService=await adapter(o,ch.channel);ch.send(employee.memberId,sheet(),'append-synthetic-boundary-draft');await bounded(boundaryService.idle());
      ch.send(employee.memberId,'对','append-synthetic-boundary-confirm');await bounded(boundaryService.idle());boundary.replies=ch.replies;
    });
    if(boundaryUrl)await phase(boundary,'postconditions',async()=>{boundary.after=await snapshot(boundaryUrl!);boundary.binding=await query(boundaryUrl!,`SELECT active,version FROM front_claw_perf.wecom_bot_bindings WHERE bot_id=$1 AND member_id=$2`,[BOT,employee.memberId]);});
    if(boundaryService)await phase(boundary,'close',()=>boundaryService!.close());
    // No mandatory zero-window assertion for an already handed-off send.
  } catch(e){evidence.errors.push(errorOf(e));}
  finally {
    evidence.finishedAt=new Date().toISOString();
    evidence.summary={cases:evidence.cases.length,checks:evidence.checks.length,failedChecks:evidence.checks.filter((c:Row)=>!c.passed).length,
      phaseErrors:evidence.cases.reduce((n:number,c:Row)=>n+c.errors.length,0),fatalErrors:evidence.errors.length};
    // Written before the unified assertions, including on failure.
    await writeFile(join(output,'pg-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  }
  expect(evidence.errors,'collection fatal errors').toEqual([]);
  expect(evidence.checks.filter((c:Row)=>!c.passed).map((c:Row)=>c.id),'all scenes finished; inspect persisted synthetic evidence').toEqual([]);
},240000);
