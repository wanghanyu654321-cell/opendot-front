import { expect, it } from 'vitest';
import path from 'node:path';

it('resolves backup tools from explicit configuration, then server binaries, then PATH', async () => {
  const { resolvePgTool } = await import('../../scripts/e2e/pg-tools.mjs');
  for (const [tool, key] of [['pg_dump', 'PG_DUMP'], ['pg_restore', 'PG_RESTORE']] as const) {
    const explicit = path.resolve('explicit-tool');
    const server = path.resolve('server-bin', tool);
    const system = path.resolve('system-bin', tool);
    const env: Record<string, string> = { [key]: explicit, PG_BIN: path.dirname(server), PATH: path.dirname(system) };
    const executable = async (file: string) => [explicit, server, system].includes(file);
    expect(await resolvePgTool(env, tool, executable)).toBe(explicit);
    delete env[key];
    expect(await resolvePgTool(env, tool, executable)).toBe(server);
    expect(await resolvePgTool(env, tool, async (file: string) => file === system)).toBe(system);
    await expect(resolvePgTool({ [key]: explicit, PATH: '' }, tool, async () => false)).rejects.toMatchObject({ code: key + '_NOT_FOUND' });
    await expect(resolvePgTool({ PATH: '' }, tool, async () => false)).rejects.toThrow(key);
  }
});
