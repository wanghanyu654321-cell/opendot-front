/**
 * M02 分段路由日志：入站 / 分类 / 提交 / 投递。只记请求号、阶段、耗时与结果，不记录消息正文。
 * 观测失败不影响业务。
 */
export type RouteStage = 'inbound' | 'classify' | 'commit' | 'deliver';
export interface RouteLogRecord {
  requestId: string; stage: RouteStage; sinceInboundMs: number;
  label?: string; target?: string; source?: string; reason?: string;
  state?: string; operationId?: string; ledgerSettled?: boolean; late?: boolean;
  delivered?: boolean; duplicate?: boolean;
}
export function createRouteLog(sink?: (record: RouteLogRecord) => void, now: () => number = () => performance.now()) {
  const started = new Map<string, number>();
  const emit = (requestId: string, stage: RouteStage, fields: Omit<RouteLogRecord, 'requestId' | 'stage' | 'sinceInboundMs'> = {}) => {
    if (stage === 'inbound') started.set(requestId, now());
    const begin = started.get(requestId) ?? now();
    const record: RouteLogRecord = { requestId, stage, sinceInboundMs: Math.max(0, Math.round((now() - begin) * 1000) / 1000), ...fields };
    if (stage === 'deliver') started.delete(requestId);
    if (started.size > 5000) started.delete(started.keys().next().value!);
    try { sink?.(Object.freeze(record)); } catch { /* 观测故障不改变业务结果 */ }
  };
  return {
    inbound: (requestId: string) => emit(requestId, 'inbound'),
    classify: (requestId: string, fields: Pick<RouteLogRecord, 'label' | 'target' | 'source' | 'reason'>) => emit(requestId, 'classify', fields),
    commit: (requestId: string, fields: Pick<RouteLogRecord, 'state' | 'operationId' | 'ledgerSettled' | 'late'>) => emit(requestId, 'commit', fields),
    deliver: (requestId: string, fields: Pick<RouteLogRecord, 'delivered' | 'duplicate' | 'state'>) => emit(requestId, 'deliver', fields),
  };
}
export type RouteLog = ReturnType<typeof createRouteLog>;
