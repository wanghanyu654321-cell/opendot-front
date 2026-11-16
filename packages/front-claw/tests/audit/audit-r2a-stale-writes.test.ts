import { expect, it, vi } from 'vitest';
import { startFrontClawOpenDotService } from '../../src/opendot/adapter.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { fakeHost, manualClock, memoryWorld, offlineChannels } from '../opendot/fixture-m07.js';

const sheet = '12号测试B店\n560（小赵）';
function gate() { let hit!:()=>void, release!:()=>void; return { reached: new Promise<void>(r=>{hit=r}), wait:new Promise<void>(r=>{release=r}), hit:()=>hit(), release:()=>release() }; }
async function start(w: Awaited<ReturnType<typeof memoryWorld>>, c: ReturnType<typeof manualClock>, owner:string) {
  const channel=offlineChannels(); const service=await startFrontClawOpenDotService(fakeHost().host, {open:w.open,now:c.now,owner,channel:channel.factory,timers:false});
  return { service,channel,say:async (text:string,id:string)=>{channel.send('m-zhao',text,id);await service.idle();} };
}
// R3：由 助手B 的缺陷特征断言改为安全断言（修前失败、修后通过）：接管后旧消费者 A 什么都不能写。
it('AUDIT regression safe (R3): stale A cannot void a pending draft after B has acquired the lease', async()=>{
  const w=await memoryWorld(), c=manualClock(), a=await start(w,c,'A'); await a.say(sheet,'report');
  const g=gate(), original=w.store.transitionPendingDraft.bind(w.store);
  const spy=vi.spyOn(w.store,'transitionPendingDraft').mockImplementationOnce(async (...args)=>{g.hit();await g.wait;return original(...args);});
  a.channel.send('m-zhao','取消','cancel'); await g.reached; c.advance(30001);
  const b=await start(w,c,'B'); expect(b.service.state()).toBe('active');
  const lease=await w.store.getConfig(CONSUMER_LEASE_KEY);
  expect((await w.store.listDrafts())[0]!.status).toBe('pending');
  g.release();await a.service.idle();
  const status=(await w.store.listDrafts())[0]!.status;
  console.info(JSON.stringify({scenario:'stale cancel',status,leaseUnchanged:(await w.store.getConfig(CONSUMER_LEASE_KEY))===lease,replies:a.channel.replies()}));
  expect(status).toBe('pending'); expect(a.channel.replies().join('')).not.toContain('已取消');
  expect(await w.store.getConfig(CONSUMER_LEASE_KEY)).toBe(lease);
  spy.mockRestore();await a.service.close();await b.service.close();
});
it('AUDIT regression safe (R3): stale A cannot create a new draft after B has acquired the lease', async()=>{
  const w=await memoryWorld(), c=manualClock(), a=await start(w,c,'A');
  const g=gate(), original=w.store.replacePendingReport.bind(w.store);
  const spy=vi.spyOn(w.store,'replacePendingReport').mockImplementationOnce(async (...args)=>{g.hit();await g.wait;return original(...args);});
  a.channel.send('m-zhao',sheet,'report');await g.reached;c.advance(30001);
  const b=await start(w,c,'B');expect(b.service.state()).toBe('active');
  expect(await w.store.listDrafts()).toHaveLength(0);g.release();await a.service.idle();
  const drafts=await w.store.listDrafts();console.info(JSON.stringify({scenario:'stale create',draftStatuses:drafts.map(d=>d.status),replies:a.channel.replies()}));
  expect(drafts).toHaveLength(0);expect(a.channel.replies()).toEqual([]);
  spy.mockRestore();await a.service.close();await b.service.close();
});
