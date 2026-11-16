/** 沿用早期骨架 integrations/opendot-front-claw/mem0-off.ts 的声明：Front Claw 一期 Mem0 关闭。 */
export const MEM0_ENABLED_FOR_FRONT_CLAW = false;
export const FRONT_CLAW_MEM0_ENV = 'FRONT_CLAW_MEM0';

/** 有人试图打开（常量或 env）就拒绝启动；适配器本身不 import 任何 Mem0 模块。 */
export function assertMem0Off(env: Readonly<Record<string, string | undefined>> = {}): void {
  const requested = (env[FRONT_CLAW_MEM0_ENV] ?? '').trim();
  if (MEM0_ENABLED_FOR_FRONT_CLAW || (requested !== '' && requested !== '0')) throw Error('mem0_must_stay_off_for_front_claw_phase1');
}
