import { expect, it, vi } from 'vitest';
import { world, policy, baseMembers, NOW } from '../role-eval/access-fixture-m03.js';
import { ACCESS_POLICY_KEY, authorize, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { createEmployeeLoop } from '../../src/role-eval/employee-loop.js';

// Independent port: passing means expected safe behavior. Original scenarios retained; assertions inverted.
const revoke = async (w: Awaited<ReturnType<typeof world>>, id: string) => {
  const next = policy(2); next.members[id]!.status = 'revoked';
  expect(await updateAccessPolicy(w.base, { expectedVersion: 1, next, actor: 'audit', reason: 'revoke', at: NOW.toISOString() })).toEqual({ ok: true, version: 2 });
};
const loopFor = (w: Awaited<ReturnType<typeof world>>) => createEmployeeLoop({
  mode: 'isolated-synthetic', store: w.base, resolve: id => w.base.getPersonByMember(id), now: () => NOW,
  send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '' }) }, employeeLoop: true, accessPolicy: true,
});
const input = (text: string, messageId: string) => ({ memberId: 'm-wang-yj', text, messageId, sessionId: 'session-m-wang-yj', bindingVersion: 1 });

it('AUDIT regression safe: old raw policy cannot resurrect revoked member', async () => {
  const w = await world(); await revoke(w, 'p-wang-yj');
  const person = await w.base.getPersonByMember('m-wang-yj');
  expect((await authorize(w.base, person, 'report_proxy', 's-b')).allowed).toBe(false);
  await expect(w.base.setConfig(ACCESS_POLICY_KEY, JSON.stringify(policy(1)))).rejects.toThrow('protected_config_key');
  await w.base.updateConfigLocked(ACCESS_POLICY_KEY, [], () => ({ [ACCESS_POLICY_KEY]: JSON.stringify(policy(1)) }));
  expect(await w.base.getConfig('front-claw-access:high-water')).toBe('2');
  expect((await authorize(w.base, person, 'report_proxy', 's-b')).allowed).toBe(false);
  expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).not.toContain('还没入账');
  expect(await w.call('m-wang-yj', '对')).not.toContain('已入账');
});

it('AUDIT regression safe: disabled actor is rejected at commit', async () => {
  const w = await world(); await w.call('m-wang-yj', '12号测试B店\n560（小赵）');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  vi.spyOn(w.base, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => {
    await w.base.savePerson({ ...(await w.base.getPersonByMember('m-wang-yj'))!, active: false });
    return original(...args);
  });
  expect(await w.call('m-wang-yj', '对')).not.toContain('已入账');
  expect((await w.base.listEntries()).some(e => e.amount === 560)).toBe(false);
});

it('AUDIT regression safe: confirming replay rejects transferred target', async () => {
  const w = await world(); await w.call('m-wang-yj', '12号测试B店\n560（小赵）');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  const spy = vi.spyOn(w.base, 'commitConfirmingDraft').mockRejectedValueOnce(Error('simulate crash before commit'));
  await loopFor(w)(input('对', 'recover-confirm'));
  expect((await w.base.listDrafts())[0]!.status).toBe('confirming');
  spy.mockImplementation(original);
  await w.base.savePerson({ ...(await w.base.getPersonByMember('m-zhao'))!, storeId: 's-a', storeName: '测试A店' });
  expect((await loopFor(w)(input('对', 'recover-confirm'))).replies.join('')).not.toContain('已入账');
  expect((await w.base.listEntries()).find(e => e.amount === 560)).toBeUndefined();
});

it('AUDIT regression safe: pending replay hides amounts after capability removal', async () => {
  const w = await world(); const text = '12号测试B店\n560（小赵）';
  await w.call('m-wang-yj', text, 'report-old');
  const next = policy(2, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'active', capabilities: [] } });
  await updateAccessPolicy(w.base, { expectedVersion: 1, next, actor: 'audit', reason: 'narrow', at: NOW.toISOString() });
  expect((await loopFor(w)(input(text, 'report-old'))).replies.join('')).not.toContain('560元');
});

it('AUDIT regression safe: cached query rechecks current policy', async () => {
  const w = await world(); const before = await w.call('m-boss', '门店排名', 'cached');
  await revoke(w, 'p-boss'); w.reset();
  expect(await w.call('m-boss', '门店排名', 'cached')).not.toBe(before);
  expect(w.spy.reads.length).toBeGreaterThan(0); // duplicate suppresses onOutbound, but returned replies retain data
});

it('AUDIT regression safe: marketing revocation suppresses outbound result', async () => {
  let w: Awaited<ReturnType<typeof world>>;
  w = await world({ router: { marketing: { enabled: true, handle: async () => { await revoke(w, 'p-boss'); return 'AUDIT_MARKETING_RESULT'; } } } });
  expect(await w.call('m-boss', '写一段朋友圈营销文案')).not.toBe('AUDIT_MARKETING_RESULT');
  expect(w.outbound).not.toContain('AUDIT_MARKETING_RESULT');
});
