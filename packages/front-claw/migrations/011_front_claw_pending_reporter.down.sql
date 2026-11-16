-- 仅撤销本次索引和序列，不修改业务行。
DROP INDEX IF EXISTS front_claw_perf.performance_drafts_pending_reporter_unique;
DROP SEQUENCE IF EXISTS front_claw_perf.pending_order_seq;
