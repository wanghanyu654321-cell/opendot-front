# M08 Issue：两库迁移、重入与保全新业务的回退（仅离线）

时间：2026-11-11 北京时间（UTC+8）。工作树 <本地路径>，基于 M07 树 d95be9f0，独立索引）。
依据：MERGED.md §M08、§9（停删命令只列不执行）、合审-08/09、T02/T17；助手B SLICES S08；M06 报告的 schema 决定（状态文本编码保留，正式列+due 索引在 M08 迁移）。

## 现状（本机可核实）
- PG 业务库只有一个迁移 `migrations/007_front_claw_perf.sql`（schema `front_claw_perf`，10 张表，全部 CREATE IF NOT EXISTS），启动时 `migratePerformance` 逐句执行，**无版本表、无 advisory lock**（M07 已测出并发首次建表会撞 23505）。
- `migratePerformance` 拒绝 ALTER/DROP，所以 008 不能走同一入口。
- M06 出站箱状态写在 `performance_notifications.status` 文本里（`pending|<到期>|<阶段>|a=|r=|tok=|by=|err=`），到期条件 `split_part(status,'|',2) <= now`，没有索引。
- M03 `updateAccessPolicy(expectedVersion=null)` 在策略行不存在时 `FOR UPDATE` 锁不到行，两写者可都成功（后写覆盖）。
- 旧业务数据：MERGED §9 指历史库 `legacy_appointment_db` 的 schema `front_claw_perf`（在共用 PG 上）。**本机没有任何真实副本**；只能用合成数据（M01–M07 流程产生）验证。
- OpenDot 底座 SQLite（`<本地路径>` CURRENT_SCHEMA_VERSION=107；:484–507 启动时自迁移，v39+ 先 `VACUUM INTO` 备份，拒绝降级）。Front Claw 不读不写它；它与业务 PG 分开迁移。
- 迁移编号：本仓只有 007；MERGED 要求保留旧 001–006 边界。新编号用 008（线上实际链未核实）。
- 线上 PG 版本：**未知，待确认**。本机测试用 PG17 用户态临时集群，**不是线上版本**。

## 范围
1. 迁移 008（up/down）：通知正式列（state/phase/attempts/resends/next_at/lease_until/lease_token/lease_owner/error/due_at）+ due 部分索引；由状态文本回填；过渡期状态文本仍是唯一写入口，列由触发器从文本推导（旧制品只写文本也保持一致）；down 只删 008 对象，不动业务行。
2. 版本表 `schema_migrations` + advisory lock：启动的 007 基线与 008 up/down 同一把锁；008 不随启动自动执行（显式命令，默认 dry-run）。
3. 修 `updateAccessPolicy` 首写竞态。
4. 数据迁移：旧 Front Claw PG（007 布局，只读连接）→ OpenDot 侧专用 Front Claw PG（同 schema，v8）。按源主键映射、逐批事务、可中断重入；pending_manager 预约可追溯转换；历史待发通知抑制不重发；冲突不覆盖。
5. 回退：R1 同库降回 v7 跑 M07 制品（行全保留，含迁移后新业务）；R2 把目标库全部行（含新业务）导出到一个新的 007 布局隔离库。
6. 预检/后检脚本（行数、校验和、金额合计、状态分布、引用完整性），默认 dry-run。
7. 服务器命令清单（停服务/删卷/清数据）只写进 REPORT 待批，一条都不执行。

## 非目标
不连服务器/共用 PG（`legacy-shared-pg-20261008-r1` 及其目录、`legacy_appointment_db`）；不清数据、不 DROP/TRUNCATE 业务表；不在线双写/CDC；不改 OpenDot SQLite；不宣称真实数据已迁完。

## 验收
- tsc、M01–M08 定向、全量、test:pg（PG17 临时，非线上）、typecheck、build。
- up/down/up 往返（业务行校验和不变、列重算一致）；触发器与 TS `decodeStatus` 逐字段一致（含畸形值）。
- 在 M01–M07 流程造出的库上迁移；并发迁移器（含并发启动）；策略首写竞态。
- 数据迁移 dry-run 零写入；每个批次边界中断后重跑结果一致；重复执行无重复；冲突不覆盖；历史通知不派发。
- 迁移后新增入账/更正/目标/预约/通知 → R1、R2 回退均保留新行，sent/unknown 不重发。
- 变异检查；m08.patch、m08-cumulative.patch、SHA256SUMS、树哈希。
