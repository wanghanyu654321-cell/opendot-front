import { expect, it, vi } from 'vitest';

it('writes lifecycle, reconnect, warning and failure reasons as safe JSON lines', async () => {
  const { createStandaloneLogger } = await import('../../src/standalone/diagnostics.js');
  const lines: string[] = [];
  const logger = createStandaloneLogger(line => lines.push(line));
  const injected = 'fake-secret-marker private-message-marker postgresql://user:fake-password@private-host/db';
  logger.info({ state: 'active', owner: injected });
  logger.warn({ reason: 'channel_down', text: injected });
  logger.info({ state: 'closed' });
  logger.warn({ type: 'backlog_alert', kind: injected });
  logger.warn({ event: 'standalone_start_failed', error: Object.assign(Error(injected), { code: 'ECONNREFUSED' }) });
  logger.warn({ event: 'standalone_start_failed', error: Object.assign(Error(injected), { code: injected }) });
  expect(lines).toHaveLength(6);
  const records = lines.map(line => { expect(line.endsWith('\n')).toBe(true); return JSON.parse(line); });
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'lifecycle', state: 'active' }),
    expect.objectContaining({ event: 'lifecycle', state: 'reconnecting', reason: 'channel_down' }),
    expect.objectContaining({ event: 'lifecycle', state: 'closed' }),
    expect.objectContaining({ event: 'warning', reason: 'backlog_alert' }),
    expect.objectContaining({ event: 'standalone_start_failed', errorCategory: 'network', errorCode: 'ECONNREFUSED', messageSummary: expect.any(String) }),
  ]));
  expect(lines.join('')).not.toMatch(/fake-secret-marker|private-message-marker|fake-password|private-host|postgresql:\/\//);
});

it('reports a startup validation failure with a useful sanitized reason', async () => {
  const { startStandalone } = await import('../../src/standalone/main.js');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await expect(startStandalone({ FRONT_DOT_CHANNEL: 'wecom', FRONT_CLAW_WECOM_BOT_SECRET: 'startup-fake-secret' })).rejects.toThrow('wecom_credential_unavailable');
    const lines = stderr.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(lines).toContainEqual(expect.objectContaining({ event: 'standalone_start_failed', errorCategory: 'configuration', errorCode: 'wecom_credential_unavailable', messageSummary: expect.any(String) }));
    expect(JSON.stringify(lines)).not.toContain('startup-fake-secret');
  } finally { stderr.mockRestore(); }
});
