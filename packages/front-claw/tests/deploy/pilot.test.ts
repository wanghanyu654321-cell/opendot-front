import { expect, it, vi } from 'vitest';
import { runAdmin } from '../../src/standalone/admin.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { createMemoryBindingStore } from '../../src/role-eval/directory-store.js';
import { ACCESS_POLICY_KEY, readPolicy, decideAccess } from '../../src/role-eval/access-policy.js';
import { EMPLOYEE_LOOP_CONFIG } from '../../src/role-eval/employee-loop.js';
import { seedSynthetic } from '../../src/standalone/synthetic.js';

export const pilotEnvironment = {
  DATABASE_ADMIN_URL: 'postgresql://pg/synthetic', FRONT_CLAW_WECOM_BOT_ID: 'pilot-bot',
  PILOT_MEMBER_ID: 'pilot-member', PILOT_CORP_ID: 'pilot-corp', PILOT_DISPLAY_NAME: '试点员工',
  PILOT_STORE_ID: 'synthetic-store', PILOT_STORE_NAME: '测试店', PILOT_ROLE: 'employee',
};

it('validates every pilot variable before opening the database or reading secret variables', async () => {
  const open = vi.fn();
  for (const key of Object.keys(pilotEnvironment).filter(key => key !== 'DATABASE_ADMIN_URL')) {
    for (const value of ['', 'bad\nvalue', 'x'.repeat(121)]) {
      const env = new Proxy({ ...pilotEnvironment, [key]: value }, { get(target, name) {
        if (/SECRET|PASSWORD|API_KEY/.test(String(name))) throw Error('unexpected_secret_read');
        return Reflect.get(target, name);
      } });
      await expect(runAdmin('seed-pilot', env, { open, migrate: vi.fn() })).rejects.toThrow('invalid_pilot_configuration');
    }
  }
  await expect(runAdmin('seed-pilot', { ...pilotEnvironment, PILOT_ROLE: 'administrator' }, { open, migrate: vi.fn() })).rejects.toThrow('invalid_pilot_configuration');
  expect(open).not.toHaveBeenCalled();
});

it('merges pilot identity, policy and employee allow-list idempotently through the shared initializer', async () => {
  const { seedPilot, parsePilotEnvironment } = await import('../../src/standalone/pilot.js');
  const store = new MemoryPerformanceStore(), bindings = createMemoryBindingStore();
  await seedSynthetic({ store, bindings });
  const input = parsePilotEnvironment(pilotEnvironment);
  await seedPilot({ store, bindings }, input);
  const before = { people: await store.listPeople(), bindings: await bindings.listBindings(), policy: await store.getConfig(ACCESS_POLICY_KEY), loop: await store.getConfig(EMPLOYEE_LOOP_CONFIG) };
  await seedPilot({ store, bindings }, input);
  expect({ people: await store.listPeople(), bindings: await bindings.listBindings(), policy: await store.getConfig(ACCESS_POLICY_KEY), loop: await store.getConfig(EMPLOYEE_LOOP_CONFIG) }).toEqual(before);
  expect(JSON.parse(before.loop!).memberIds).toEqual(['synthetic-member', 'pilot-member']);
  const person = await store.getPersonByMember('pilot-member');
  const binding = (await bindings.listBindings()).find(row => row.memberId === 'pilot-member');
  expect(binding).toMatchObject({ corpId: 'pilot-corp', accountId: person!.accountId });
  expect(decideAccess(await readPolicy(store), person, 'report_self', 'synthetic-store').allowed).toBe(true);
  expect(decideAccess(await readPolicy(store), person, 'progress_other', 'synthetic-store').allowed).toBe(false);
  expect(await store.listEntries()).toEqual([]);
});

it('refuses to overwrite an existing identity or enable an unrelated employee store', async () => {
  const { seedPilot, parsePilotEnvironment } = await import('../../src/standalone/pilot.js');
  const store = new MemoryPerformanceStore(), bindings = createMemoryBindingStore();
  await seedSynthetic({ store, bindings });
  const save = vi.spyOn(store, 'savePerson');
  await expect(seedPilot({ store, bindings }, parsePilotEnvironment({ ...pilotEnvironment, PILOT_STORE_ID: 'another-store' }))).rejects.toThrow('seed_loop_conflict');
  expect(save).not.toHaveBeenCalled();
});
