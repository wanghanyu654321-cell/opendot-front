# M08 迁移与回退（离线工具，默认 dry-run）

构建后：`node dist/migration/cli.js <命令> [--apply] [--source-label=…] [--batch=200]`。连接串只从 env 读、不打印：
`FRONT_CLAW_MIGRATE_SOURCE_URL`（旧库**授权副本**，只读连接）、`FRONT_CLAW_MIGRATE_TARGET_URL`（OpenDot 侧专用 Front Claw PG）、
`FRONT_CLAW_MIGRATE_ROLLBACK_URL`（R2 回退用的新隔离库）。含 `legacy-shared-pg` / `legacy_appointment_db` 的 URL 一律拒绝；源=目标、目标=回退库也拒绝。

| 命令 | 读/写 | 说明 |
|---|---|---|
| schema-status | 只读 | 版本：0 空库 / 7 只有 007 表 / 8 |
| schema-up | 默认 dry-run（执行后回滚） | advisory lock → 007 基线 → 008（回填通知列、建 due 索引、版本表、导入台账）；已应用则核对校验和 |
| schema-down | 默认 dry-run | 只删 008 的触发器/函数/列/索引和版本行 8；业务行、台账保留。**先停所有 Front Claw 写者** |
| preflight | 只读 | 源形状、行数、校验和、金额合计、状态分布、引用完整性、目标逐行分类（新增/采纳/已导入/冲突） |
| import | 默认 dry-run | 逐表逐批事务导入；台账记源键、源/目标 sha、转换名；可中断重跑；冲突不覆盖 |
| postflight | 只读 | 源每行都在目标且台账一致；导入子集校验和、金额等于预期；迁移后新增/改动单列；抑制的通知不得再待发 |
| export-rollback | 默认 dry-run | R2：目标库全部行（含迁移后新业务）导出到新的 007 隔离库，复核每行 sha |

转换：预约 `pending_manager`→`registered`；历史 `pending*` 通知→`not_sent …err=migrated_history_suppressed`；历史报数草稿的提醒/作废通知置 `unknown` 并按 M06 确定性 ID 预置已抑制行；不迁 M07 租约行。
