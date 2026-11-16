/**
 * R1：受保护的配置键。访问策略、策略高水位与策略审计只能经 updateAccessPolicy（版本化、单调递增）写入；
 * 通用 setConfig 一律拒绝（防止旧版本原文被回写复活已撤权身份）。
 */
export const PROTECTED_CONFIG_KEYS = ['front-claw-access', 'front-claw-access:high-water'] as const;
export const PROTECTED_CONFIG_PREFIXES = ['front-claw-access:audit:'] as const;
export function assertWritableConfigKey(key: string): void {
  if ((PROTECTED_CONFIG_KEYS as readonly string[]).includes(key) || PROTECTED_CONFIG_PREFIXES.some(prefix => key.startsWith(prefix))) throw Error('protected_config_key');
}
/**
 * R1：全库统一的配置行加锁顺序——策略高水位行第一（它总是先被 insertConfigIfAbsent 建好，是策略变更的串行点），
 * 其余键按字典序。入账门（FOR SHARE）、发送事务（FOR SHARE）与 updateConfigLocked（FOR UPDATE）都按此顺序，避免交叉死锁。
 */
export function configLockOrder(keys: readonly string[]): string[] {
  const unique = [...new Set(keys.filter(key => !!key))];
  const first = 'front-claw-access:high-water';
  return [...unique.filter(key => key === first), ...unique.filter(key => key !== first).sort()];
}
