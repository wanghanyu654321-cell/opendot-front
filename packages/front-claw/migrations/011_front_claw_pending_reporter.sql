-- D174：按员工跨门店、跨会话约束；存量冲突须先审查，不静默作废业务数据。
CREATE SEQUENCE IF NOT EXISTS front_claw_perf.pending_order_seq AS bigint NO CYCLE CACHE 1;
CREATE UNIQUE INDEX performance_drafts_pending_reporter_unique
  ON front_claw_perf.performance_drafts (reporter_person_id) WHERE status = 'pending';
