/** R4（R3A-08 / D99）：旧入口开关在打开存储和迁移之前判定，关闭时零 DB 副作用。 */
import { expect, it, vi } from 'vitest';
import { bootFrontClaw } from '../../src/role-eval/front-claw-boot.js';
import { LegacyEntryDisabled } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { readFileSync } from 'node:fs';

it('bootFrontClaw 默认关旧入口：open 不被调用（启动前零存储副作用）', async () => {
  const open = vi.fn(async () => { throw new Error('open_should_not_be_called'); });
  const send = async () => 'sent' as const;
  const model = { complete: async () => ({ type: 'chat' as const, text: 'x' }) };
  await expect(bootFrontClaw({ env: {}, send, model, open })).rejects.toBeInstanceOf(LegacyEntryDisabled);
  expect(open).not.toHaveBeenCalled();
});

it('源码：legacy 开关判定出现在 openPerformanceStore / applyDirectoryMigration / options.open 之前', () => {
  const src = readFileSync(new URL('../../src/role-eval/front-claw-boot.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export async function bootFrontClaw');
  const body = src.slice(start, src.indexOf('export function createStoreBusinessPort'));
  const gate = Math.min(...['legacyEntryAllowed', 'LegacyEntryDisabled'].map(s => {
    const i = body.indexOf(s);
    return i < 0 ? Infinity : i;
  }));
  expect(gate).toBeLessThan(body.indexOf('options.open'));
  expect(gate).toBeLessThan(body.indexOf('openPerformanceStore'));
  expect(gate).toBeLessThan(body.indexOf('applyDirectoryMigration'));
});
