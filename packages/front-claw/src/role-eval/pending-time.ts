export function timestampMicros(value: string): bigint {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return -1n;
  const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? '';
  return BigInt(ms) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6) || '0');
}
