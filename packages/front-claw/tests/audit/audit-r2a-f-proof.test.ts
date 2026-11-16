import {expect,it} from 'vitest';
import {decodeStatus,wellFormedStatus} from '../../src/role-eval/notification-status.js';
it('AUDIT proof domain: err=f=9 SQL probe is not a valid TS delivery status',()=>{
  const raw='pending|2026-11-12T00:00:00.000Z|sending|a=1|r=0|f=123456789012345|tok=t|by=w|err=f=9';
  expect(wellFormedStatus(raw)).toBe(false);expect(decodeStatus(raw).delivery).toMatchObject({fence:0,error:'malformed_status'});
  console.info(JSON.stringify({raw,ts:decodeStatus(raw).delivery,sqlProbeReported:123456789012345}));
});
it('AUDIT proof domain: canonical f is unique and within exact integer range',()=>{
  for(const f of [1,2,999999999999999]){
    const raw=`pending|2026-11-12T00:00:00.000Z|claimed|a=0|r=0|f=${f}|tok=t|by=w`;
    expect(wellFormedStatus(raw)).toBe(true);expect(decodeStatus(raw).delivery.fence).toBe(f);
    expect(wellFormedStatus(raw+'|f=9')).toBe(false);
  }
});
