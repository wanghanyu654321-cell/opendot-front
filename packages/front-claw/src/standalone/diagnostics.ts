import type { OpenDotHostLogger } from '../opendot/host-contract.js';

const summaries: Record<string, [string, string]> = {
  wecom_credential_unavailable: ['configuration', 'Long connection credentials are incomplete'],
  local_database_required: ['configuration', 'Database target must be local'],
  offline_approval_required: ['configuration', 'Offline approval is required'],
  schema_not_latest: ['database', 'Database migrations are required'],
  invalid_platform_capabilities: ['configuration', 'Platform capability configuration is invalid'],
  invalid_model_configuration: ['configuration', 'Model configuration is incomplete or invalid'],
  ECONNREFUSED: ['network', 'Connection refused'], ETIMEDOUT: ['network', 'Connection timed out'],
  ENOTFOUND: ['network', 'Host resolution failed'], EADDRINUSE: ['network', 'Local health port is already in use'],
  '28P01': ['database', 'Database authentication failed'], '42501': ['database', 'Database permission denied'],
  '3D000': ['database', 'Database does not exist'], ERR_INVALID_URL: ['configuration', 'A configured URL is invalid'],
  '57P01': ['database', 'Database connection terminated by administrator'],
};

/** Never serialize raw errors: messages can contain credentials, connection strings or user content. */
export function safeFailure(error: unknown) {
  const failure = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const code = [failure.code, failure.message].find(value => typeof value === 'string' && Object.hasOwn(summaries, value)) as string | undefined;
  const [errorCategory, messageSummary] = code ? summaries[code]! : ['runtime', 'Operation failed; untrusted details withheld'];
  return { errorCategory, errorCode: code ?? 'unclassified', messageSummary };
}

export function createStandaloneLogger(write?: (line: string) => void): OpenDotHostLogger {
  const emit = (level: string, fields: Record<string, unknown>) => {
    let record: Record<string, unknown>;
    if (fields.event === 'standalone_start_failed') record = { event: fields.event, ...safeFailure(fields.error) };
    else if (fields.event === 'database_pool_error') {
      const { errorCategory, errorCode } = safeFailure(fields.error);
      record = { event: fields.event, errorCategory, errorCode };
    } else if (fields.event === 'inbound_message') {
      // The adapter owns these categorical diagnostics; ignore all additional fields.
      record = Object.fromEntries(['event', 'operationId', 'route', 'gateReason', 'pendingSequence', 'modelMs', 'errorCategory'].map(key => [key, fields[key]]));
    } else if (['active', 'closed', 'standby', 'disabled', 'ready'].includes(String(fields.state))) record = { event: 'lifecycle', state: fields.state };
    else if (fields.reason === 'channel_down') record = { event: 'lifecycle', state: 'reconnecting', reason: 'channel_down' };
    else record = { event: 'warning', reason: ['lease_lost', 'closing', 'start_failed'].includes(String(fields.reason)) ? fields.reason
      : ['unknown_alert', 'backlog_alert', 'recovered_unknown'].includes(String(fields.type)) ? fields.type : 'runtime_warning',
      ...safeFailure(fields.error) };
    const line = JSON.stringify({ level, ...record }) + '\n';
    if (write) write(line);
    else (level === 'warn' ? process.stderr : process.stdout).write(line);
  };
  return { info: fields => emit('info', fields), warn: fields => emit('warn', fields) };
}
