import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  decideAccess,
} from '../../src/role-eval/access-policy.js';
import {
  planPilotSwitch,
  type PilotSwitchRequest,
  type PilotSwitchSnapshot,
} from '../../src/standalone/pilot-switch.js';

export function switchFixture(): {
  snapshot: PilotSwitchSnapshot;
  input: PilotSwitchRequest;
} {
  const employee = [
    'report_self',
    'progress_self',
    'marketing',
    'correct_own',
    'appointment_submit',
  ];
  return {
    snapshot: {
      people: [
        {
          personId: 'pilot-person',
          accountId: 'pilot-account',
          memberId: 'pilot-member',
          displayName: '合成员工',
          storeId: 'store-b',
          storeName: '合成B店',
          tier: 'employee',
          roles: ['marketing'],
          active: true,
        },
      ],
      bindings: [
        {
          botId: 'pilot-bot',
          corpId: 'pilot-corp',
          memberId: 'pilot-member',
          accountId: 'pilot-account',
          version: 1,
          active: true,
        },
      ],
      loopRaw: JSON.stringify({
        enabled: true,
        storeId: 'store-b',
        memberIds: ['pilot-member'],
      }),
      rawPolicy: {
        highWater: '2',
        policy: JSON.stringify({
          version: 2,
          enterprise: employee,
          stores: { 'store-b': employee },
          roles: {
            employee,
            manager: ['report_self', 'progress_self'],
            owner: ['progress_self'],
          },
          members: {
            'pilot-person': {
              role: 'employee',
              storeIds: ['store-b'],
              status: 'active',
              capabilities: employee,
            },
          },
        }),
      },
    },
    input: {
      personId: 'pilot-person',
      accountId: 'pilot-account',
      storeId: 'store-b',
      tier: 'manager',
      expectedVersion: 2,
      actor: 'pilot-admin',
      reason: 'single-store product acceptance',
      at: '2026-11-22T10:00:00.000Z',
    },
  };
}

describe('single-account single-store pilot tier plan', () => {
  it.each(['enterprise', 'store', 'current-tier', 'target-tier'])(
    'refuses an explicitly empty %s ceiling instead of reviving denied access',
    (layer) => {
      const { snapshot, input } = switchFixture();
      const policy = JSON.parse(snapshot.rawPolicy.policy!);
      if (layer === 'enterprise') policy.enterprise = [];
      if (layer === 'store') policy.stores['store-b'] = [];
      if (layer === 'current-tier') policy.roles.employee = [];
      if (layer === 'target-tier') policy.roles.manager = [];
      snapshot.rawPolicy.policy = JSON.stringify(policy);
      expect(() => planPilotSwitch(snapshot, input)).toThrow(
        'pilot_grant_inactive',
      );
    },
  );
  it('previews manager access without mutating the snapshot, binding, identity or other tiers', () => {
    const { snapshot, input } = switchFixture();
    const original = structuredClone(snapshot);
    const plan = planPilotSwitch(snapshot, input);
    expect(snapshot).toEqual(original);
    expect(plan.changed).toBe(true);
    expect(plan.before.version).toBe(2);
    expect(plan.policy.version).toBe(3);
    expect(plan.person).toEqual({ ...snapshot.people[0], tier: 'manager' });
    expect(plan.policy.members['pilot-person']).toMatchObject({
      role: 'manager',
      storeIds: ['store-b'],
      status: 'active',
    });
    expect(plan.effective).toContain('store_summary');
    expect(plan.effective).toContain('target_set');
    expect(plan.effective).toContain('correct_store');
    expect(plan.effective).not.toContain('stores_ranking');
    expect(plan.policy.roles.owner).toEqual(['progress_self']);
    plan.person.roles.push('training');
    expect(snapshot).toEqual(original);
  });

  it('downgrades a manager to employee and removes every manager-only ability', () => {
    const { snapshot, input } = switchFixture();
    const manager = planPilotSwitch(snapshot, input);
    const next = {
      ...snapshot,
      people: [manager.person],
      rawPolicy: { policy: JSON.stringify(manager.policy), highWater: '3' },
    };
    const employee = planPilotSwitch(next, {
      ...input,
      expectedVersion: 3,
      tier: 'employee',
    });
    expect(employee.person.tier).toBe('employee');
    expect([...employee.effective].sort()).toEqual([
      'appointment_submit',
      'correct_own',
      'marketing',
      'progress_self',
      'report_self',
    ]);
    expect(employee.policy.version).toBe(4);
  });

  it('grants owner business access only in B and forbids both kinds of reporting', () => {
    const { snapshot, input } = switchFixture();
    const owner = planPilotSwitch(snapshot, { ...input, tier: 'owner' });
    expect(owner.effective).toContain('store_summary');
    expect(owner.effective).toContain('stores_ranking');
    expect(owner.effective).not.toContain('report_self');
    expect(owner.effective).not.toContain('report_proxy');
    for (const cap of CAPABILITIES) {
      expect(
        decideAccess(JSON.stringify(owner.policy), owner.person, cap, 'store-a')
          .allowed,
      ).toBe(false);
      expect(
        decideAccess(JSON.stringify(owner.policy), owner.person, cap, 'store-c')
          .allowed,
      ).toBe(false);
    }
  });

  it('does not increment a version when the requested tier and permissions already match', () => {
    const { snapshot, input } = switchFixture();
    const plan = planPilotSwitch(snapshot, { ...input, tier: 'employee' });
    expect(plan.changed).toBe(false);
    expect(plan.policy.version).toBe(2);
  });

  it.each([
    'wrong-version',
    'wrong-account',
    'wrong-store',
    'inactive-person',
    'inactive-binding',
    'wrong-binding',
    'extra-binding',
    'extra-person',
    'extra-store',
    'extra-grant',
    'revoked',
    'empty-capabilities',
    'missing-high-water',
    'role-mismatch',
    'wrong-loop',
  ])('refuses %s before producing a writable plan', (scenario) => {
    const { snapshot, input } = switchFixture();
    const policy = JSON.parse(snapshot.rawPolicy.policy!);
    if (scenario === 'wrong-version') input.expectedVersion = 1;
    if (scenario === 'wrong-account') input.accountId = 'another-account';
    if (scenario === 'wrong-store') input.storeId = 'store-a';
    if (scenario === 'inactive-person') snapshot.people[0]!.active = false;
    if (scenario === 'inactive-binding') snapshot.bindings[0]!.active = false;
    if (scenario === 'wrong-binding')
      snapshot.bindings[0]!.accountId = 'another-account';
    if (scenario === 'extra-binding')
      snapshot.bindings.push({
        ...snapshot.bindings[0]!,
        botId: 'another-bot',
      });
    if (scenario === 'extra-person')
      snapshot.people.push({
        ...snapshot.people[0]!,
        personId: 'another-person',
      });
    if (scenario === 'extra-store') policy.stores['store-a'] = ['report_self'];
    if (scenario === 'extra-grant')
      policy.members.other = { ...policy.members['pilot-person'] };
    if (scenario === 'revoked')
      policy.members['pilot-person'].status = 'revoked';
    if (scenario === 'empty-capabilities')
      policy.members['pilot-person'].capabilities = [];
    if (scenario === 'missing-high-water') snapshot.rawPolicy.highWater = null;
    if (scenario === 'role-mismatch')
      policy.members['pilot-person'].role = 'owner';
    if (scenario === 'wrong-loop')
      snapshot.loopRaw = JSON.stringify({
        enabled: true,
        storeId: 'store-a',
        memberIds: ['pilot-member'],
      });
    snapshot.rawPolicy.policy = JSON.stringify(policy);
    const before = structuredClone(snapshot);
    expect(() => planPilotSwitch(snapshot, input)).toThrow();
    expect(snapshot).toEqual(before);
  });
});
