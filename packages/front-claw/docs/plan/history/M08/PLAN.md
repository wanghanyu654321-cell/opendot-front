# M08 Plan

## 默认值（D51–D62，可改）
- D51 008 不随应用启动执行；`front-claw-migrate schema-up --apply` 显式执行。应用启动只跑 007 基线（现行为）并探测版本：v≥8 用索引化到期查询，否则用原文本查询。
- D52 过渡期唯一写入口仍是 `status` 文本；008 的列由 BEFORE INSERT OR UPDATE 触发器从文本推导（直接写列会被覆盖）。M07 制品在 v8 库上照常工作。正式“以列为准”留到后续里程碑。
- D53 畸形的 pending 行（第二段不是定长 ISO）`delivery_due_at = NULL`（不到期、不派发），由预检/后检列为异常；纯 `pending` 为 `-infinity`（立即到期，同 M06）。
- D54 计数字段用 JS `parseInt` 同义解析，超出 int 范围夹到 int 边界（不让写入失败）。
- D55 advisory lock：schema 迁移键 (0x46434C57, 7)，数据导入键 (0x46434C57, 8)，均为事务级锁。
- D56 008 已应用但 SQL 校验和不同 → 拒绝（不静默重跑）。down 只删 008 的触发器/函数/列/索引和版本行 8；保留 `schema_migrations` 与导入台账（台账是数据）。
- D57 数据迁移源连接只读（`default_transaction_read_only=on`）；源和目标是同一库、或 URL 含 `legacy-shared-pg` / `legacy_appointment_db` → 拒绝（要用历史库须先由用户授权导出副本、恢复到隔离库）。
- D58 转换：预约 `pending_manager`→`registered`（M05“登记即成立”），其它状态原样；通知凡 `pending*` → `not_sent|-|-|a=原|r=原|err=migrated_history_suppressed`（历史不重发；sent/not_sent/unknown 原样）；不迁运行态行 `front-claw-opendot-consumer`。每行台账记源 sha、目标 sha、转换名。
- D58b（实施中补充）报数草稿 pending/void 的 reminder/void_notice 由 none 改 unknown，并按 M06 确定性 ID 预置 not_sent 抑制通知行（transform=draft_notice_suppressed），避免迁移后派发器补发历史提醒。
- D59 目标已有同主键行且内容≠预期 → 停止并报冲突，不覆盖；台账已有且一致 → 跳过（重入）。
- D60 批大小默认 200，逐批一个事务（批内：行 + 台账一起提交）。
- D61 R1 回退 = 停写 → schema-down → 起 M07 制品（同库，行全留）。R2 = `export-rollback` 把目标库全部 007 列导出到新的隔离 007 库（目标为准 upsert；目的库独有的行保留）。旧制品 f2a8105 不认识 `registered`/M06 编码：不在回退集合内，按 MERGED “暂停接单、保全数据、前向修复”。
- D62 CLI 全部默认 dry-run；连接串只从 env 读（FRONT_CLAW_MIGRATE_SOURCE_URL / _TARGET_URL / _ROLLBACK_URL），不落盘、不打印。

## 步骤
0. 工作树 + node_modules（硬链接复制自 repo-m07，lock 未变）；查其他写者。
1. `migrations/008_front_claw_delivery.sql` + `.down.sql`；`src/role-eval/schema-migrations.ts`（版本探测、up/down、锁、校验和）。
2. `migratePerformance` 包事务 + advisory lock；`performance-open` 探测版本，传 `deliveryColumns` 给 store；store 的 claim 查询双版本。
3. `updateAccessPolicy`：先 `insertConfigIfAbsent(高水位,'0')`，再以高水位行为第一把 FOR UPDATE 锁（`updateConfigLocked(高水位,[策略])`），锁到后才读策略 → 首写串行。
4. `src/migration/`：`inventory.ts`（规范列、行 sha、表校验和、金额合计、状态分布、引用完整性）、`import.ts`（preflight/import/postflight）、`rollback-export.ts`、`guards.ts`、`cli.ts`。
5. 测试：单元（MemorySql：锁语句、策略首写串行、守卫、转换、CLI 默认 dry-run）；PG17：往返、触发器一致性、M01–M07 流程库迁移、并发迁移器/并发启动、策略首写竞态、导入（dry-run 零写/中断重入/幂等/冲突/历史不派发）、新业务后 R1/R2、应用 v8 模式派发。
6. 删除评估：无新增删除（PLAN 内不删文件；`migrations/007` 保持只读基准）。
7. 验证 + 变异 + 产物 + REPORT（含服务器命令清单，待批不执行）。

## 参考
- golang-migrate / Flyway：版本表 + 校验和 + advisory lock（golang-migrate postgres 驱动用 `pg_advisory_lock`）；flyway `validate` 拒绝已应用迁移被改。
- PostgreSQL 文档：显式锁 §13.3.5 advisory locks；`CREATE INDEX … WHERE` 部分索引。
