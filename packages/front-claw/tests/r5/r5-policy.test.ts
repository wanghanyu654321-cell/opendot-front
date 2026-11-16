// R5 D5：老板不能报单；营销默认关，按企微 ID 按人开通；空 capabilities 全拒。
import { describe, expect, it } from 'vitest';
import {
  decideAccess, enableOptInByMemberId, enableOptInForMember, OPT_IN_CAPABILITIES, TIER_FORBIDDEN, type AccessPolicy,
} from '../../src/role-eval/access-policy.js';
import { basePeople, policy } from '../role-eval/access-fixture-m03.js';

const zhao = basePeople.find(p => p.personId === 'p-zhao')!;
const wang = basePeople.find(p => p.personId === 'p-wang-yj')!;
const boss = basePeople.find(p => p.personId === 'p-boss')!;
const raw = (p: AccessPolicy) => JSON.stringify(p);

describe('R5 档位：老板不能报单', () => {
  it('TIER_FORBIDDEN.owner 含 report_self / report_proxy，策略配得再宽也越不过', () => {
    expect(TIER_FORBIDDEN.owner).toEqual(['report_self', 'report_proxy']);
    const wide = policy(1, undefined, { roles: { employee: [...(policy(1).roles.employee), 'report_self'], manager: policy(1).roles.manager, owner: ['report_self', 'report_proxy', 'progress_self', 'marketing'] } });
    expect(decideAccess(raw(wide), boss, 'report_self', 's-a').allowed).toBe(false);
    expect(decideAccess(raw(wide), boss, 'report_proxy', 's-a').allowed).toBe(false);
    expect(decideAccess(raw(wide), boss, 'progress_self', 's-a').allowed).toBe(true);
  });
});

describe('R5 营销：默认关，按企微 ID 按人开通', () => {
  it('OPT_IN 只有 marketing', () => {
    expect([...OPT_IN_CAPABILITIES]).toEqual(['marketing']);
  });
  it('capabilities 未定义 → 常规能力照常、营销关', () => {
    const p = policy(1);
    expect(p.members['p-zhao']?.capabilities).toBeUndefined();
    expect(decideAccess(raw(p), zhao, 'report_self', 's-b').allowed).toBe(true);
    expect(decideAccess(raw(p), zhao, 'marketing', 's-b').allowed).toBe(false);
    expect(decideAccess(raw(p), wang, 'marketing', 's-b').allowed).toBe(false);
    expect(decideAccess(raw(p), boss, 'marketing', 's-a').allowed).toBe(false);
  });
  it('空数组 → 全部拒绝（含常规能力）', () => {
    const p = policy(1);
    p.members['p-zhao'] = { ...p.members['p-zhao']!, capabilities: [] };
    expect(decideAccess(raw(p), zhao, 'report_self', 's-b').allowed).toBe(false);
    expect(decideAccess(raw(p), zhao, 'marketing', 's-b').allowed).toBe(false);
  });
  it('只列出选配项 [marketing] → 常规不收窄，营销开', () => {
    const p = enableOptInForMember(policy(1), 'p-zhao', 'marketing');
    expect(p.members['p-zhao']!.capabilities).toEqual(['marketing']);
    expect(decideAccess(raw(p), zhao, 'report_self', 's-b').allowed).toBe(true);
    expect(decideAccess(raw(p), zhao, 'marketing', 's-b').allowed).toBe(true);
    expect(decideAccess(raw(p), wang, 'marketing', 's-b').allowed).toBe(false);
  });
  it('按企微 memberId 开通（WeCom ID）', () => {
    const p = enableOptInByMemberId(policy(1), basePeople, 'm-wang-yj', 'marketing');
    expect(decideAccess(raw(p), wang, 'marketing', 's-b').allowed).toBe(true);
    expect(decideAccess(raw(p), zhao, 'marketing', 's-b').allowed).toBe(false);
  });
  it('列出常规项则收窄，营销仍须显式', () => {
    const p = policy(1);
    p.members['p-zhao'] = { ...p.members['p-zhao']!, capabilities: ['report_self'] };
    expect(decideAccess(raw(p), zhao, 'report_self', 's-b').allowed).toBe(true);
    expect(decideAccess(raw(p), zhao, 'report_proxy', 's-b').allowed).toBe(false);
    expect(decideAccess(raw(p), zhao, 'marketing', 's-b').allowed).toBe(false);
    p.members['p-zhao'] = { ...p.members['p-zhao']!, capabilities: ['report_self', 'marketing'] };
    expect(decideAccess(raw(p), zhao, 'marketing', 's-b').allowed).toBe(true);
    expect(decideAccess(raw(p), zhao, 'report_proxy', 's-b').allowed).toBe(false);
  });
});
