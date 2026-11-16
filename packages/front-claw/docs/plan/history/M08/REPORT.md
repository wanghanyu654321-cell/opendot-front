# M08 报告：两库迁移、重入与保全新业务的回退（仅离线）

时间：2026-11-11 21:00–21:30 北京时间（UTC+8）。工作树 <本地路径>，基于 f2a8105 + M07 累计补丁 = 树 d95be9f0）。没有 commit/push/PR，没有连服务器/ssh/真实企微，没有读 env/凭据，没有 sudo/docker，没有删工作树和临时目录以外的任何东西。

## 1. 改了什么
- **008 迁移**（`migrations/008_front_claw_delivery.sql` + `.down.sql`，SQL 同时内嵌在 `src/role-eval/schema-migrations.ts`，有逐字一致的测试）：
  - `performance_notifications` 加 10 列：state/phase/attempts/resends/next_at/lease_until/lease_token/lease_owner/error/due_at；部分索引 `performance_notifications_due_idx (delivery_due_at, created_at, notification_id) WHERE delivery_due_at IS NOT NULL`。
  - 触发器从 M06 状态文本推导这些列（BEFORE INSERT OR UPDATE），存量行一次回填；过渡期唯一写入口仍是文本，M07 制品照常可用。
  - 版本表 `schema_migrations`（版本、名称、校验和），已应用的 008 校验和不同就拒绝。
  - down 只删 008 的触发器、函数、10 列、索引和版本行 8；业务行、版本表、导入台账保留。
- **启动行为**：008 不随启动执行。启动仍只跑 007 基线，但现在在事务内先拿 advisory lock (0x46434C57,7)，并发首次启动不再撞 23505。随后探测版本：v8 用 `delivery_due_at <= now` 的索引化到期查询，v7 用原文本查询。
- **策略首写竞态修复**（`updateAccessPolicy`，expectedVersion=null）：先 `INSERT … ON CONFLICT DO NOTHING` 补出高水位行，再按“高水位 FOR UPDATE → 策略”固定锁序更新。真实 PG 上 4 路并发首写 10 轮，每轮恰好一个成功，其余 version_conflict，审计只 1 条。
- **迁移工具**（`src/migration/*`，构建后 `node dist/migration/cli.js`，全部默认 dry-run，连接串只从 env 读、不打印；说明见 `migrations/README-m08.md`）：
  - schema-status / schema-up / schema-down。
  - preflight：只读，给出行数、逐表校验和、按门店|状态的金额合计、状态分布、孤儿引用、畸形 pending，以及目标库逐行分类（新增/采纳/已导入/冲突）。
  - import：每批 200 行一个事务，行和台账一起提交；可中断后重跑；遇冲突不覆盖；数据导入锁 (0x46434C57,8)。
  - postflight：默认严格；营业后复核时加 `--allow-changed`。
  - export-rollback：即 R2。
- **转换（可追溯，台账记源 sha/目标 sha/转换名）**：
  - 预约 `pending_manager` → `registered`。
  - 历史 `pending*` 通知 → `not_sent …err=migrated_history_suppressed`。
  - 未结报数草稿的 reminder/void_notice 由 none 改为 unknown，并按 M06 确定性 ID 预置“已抑制”通知行，迁移后的派发器不会补发历史提醒。
  - 不迁 M07 租约运行态行。
- **保护**：
  - 源连接只读（`default_transaction_read_only=on`）。
  - 凡 URL 含 `legacy-shared-pg` 或 `legacy_appointment_db` 一律拒绝，URL 编码后的形式也拒绝。
  - 源=目标、目标=回退库也拒绝。

## 2. 数字
- tsc / typecheck / build：0 错。
- 分片测试：M01 15、M02 18、M03 21、M04 25、M05 20、M06 20、M07 27、M08 单测 9，全过。回归 15 文件 200/200。
- 全量 vitest：934 中 932 过。2 个失败仅 `tests/native/live-model-smoke`，是基线已知问题。
- 真实 PG（临时 PG17 **非线上版本**）test:pg：9 文件 55/55，其中 M08 新增 11；M08 PG 用例单独重复 5 轮，11/11 ×5。不设 FRONT_CLAW_PG_BIN 时默认路径不变（PG16 不存在，55 跳过）。
- M08 PG 用例覆盖：
  - 在 M01–M07 流程灌出的库上做 up/down/up 往返：业务快照逐行相等，校验和相等，dry-run 零改动，EXPLAIN 走到期索引。
  - 触发器与 TS 解码在 400 条随机及边界状态上逐列一致。
  - v8 库与 v7 孪生库派发结果逐行一致，并用探针证明 v8 实例确实按列取到期。
  - 6 路并发 schema-up 加 6 实例并发启动，5 轮全部成功且只应用一次；校验和被篡改时拒绝。
  - 迁移侧：
    - 源只读：写入报 25006。
    - 预检和 dry-run 对目标零写入。
    - 每个批次边界中断后重跑，结果一致。
    - 并发导入器结果一致。
    - 冲突拒绝；导入途中被另一写者插入的冲突行，整批回滚且不覆盖。
    - 严格后检能抓到导入后被改的行。
  - 迁移后继续营业（入账、更正、目标、预约、sent/unknown）再回退：
    - R2：导出到新的隔离 007 库，新业务和审计全在；目的库独有行保留；差异行以目标为准。
    - R1：同库降回 v7，快照不变，M07 制品照常营业。
    - 两条路径都不重发；之后再升回 v8，后检仍通过。
  - dist CLI 冒烟：0→8→7→8 往返通过，守卫生效。
- 变异检查 22/22 抓到，每项还原后 sha256 一致。覆盖：触发器解析、回填、down 范围、两把锁、校验和、dry-run、v8 查询选择、策略锁序、三个守卫、五个转换、冲突、台账幂等、严格后检、R2 差异行。

## 3. 产物与 sha256（见 SHA256SUMS）
- `m08.patch`（对 d95be9f0）：22 文件，+1712/−8。
- `m08-cumulative.patch`（对 f2a8105）。
- 三种重放（f2a8105+累计；d95be9f0+m08；f2a8105+m07累计+m08）都得到树 **79c86525dcf4cb01d25882871d94069f96a0f7ce**（`m08-tree.txt`）。
- package-lock 未改。

## 4. 兼容矩阵
| 程序 \ Front Claw PG | v7（仅 007） | v8（007+008） |
|---|---|---|
| M08 制品 | 可用（文本到期查询；不会自动升 008） | 可用（索引化到期查询） |
| M07 制品 | 可用 | 可用（只写文本，触发器同步列；已测派发一致） |
| f2a8105 旧制品 | **不兼容**导入后的数据（不认识 `registered` 和 M06 编码）：按 MERGED 走“暂停接单、保全数据、前向修复”，不宣称一键回滚 | 同左 |
| OpenDot SQLite（db.ts CURRENT_SCHEMA_VERSION=107） | 与 Front Claw PG 互相独立：OpenDot 启动时自迁移，v39+ 有 VACUUM INTO 备份，拒绝降级；Front Claw 不碰它，本片**未运行** OpenDot 迁移 | 同左 |

回退条件：
- 没有新业务时：恢复迁移前快照（快照方式待定）。
- 已有新业务时：
  - R1：先停所有写者，再 `schema-down --apply`，再起 M07 制品。必须先停写，否则 v8 实例的取件查询会失败。
  - R2：`export-rollback --apply` 导到新库，再把 M07 制品指过去。

## 5. 需要你批准的服务器命令清单（一条都没执行）
`<…>` 为待核实占位，补齐真实对象后才可审批。顺序：A 只读盘点 → B 停写 → C 迁移 → D 回退（按需） → E 清理（与切换分开）。
**排除，永不在本清单内**：
- `legacy-shared-pg-20261008-r1` 及其数据目录、bind 目录、共用 DB 网络；
- 容器 `claw-product-closeout-internal-20261012-r1`、`frontagent-training-20261015-r1`、`frontagent-unified-20261015-r1`；
- 全局 prune、`down -v`、schema/库 DROP、TRUNCATE、递归 rm。

**A. 只读盘点（需授权登录服务器）**
```
systemctl list-units --all --no-pager | grep -Ei 'front|claw|mem0|pilot'
docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Mounts}}\t{{.Networks}}'
docker volume inspect qiwe-frontagent-existing-b58d72d3-4908-45cc-9bf8-a268bfcf79d3
docker ps -a --filter volume=qiwe-frontagent-existing-b58d72d3-4908-45cc-9bf8-a268bfcf79d3 --format '{{.ID}} {{.Names}}'
docker network ls --no-trunc | grep b419d41c
docker network inspect <b419d41c完整ID> --format '{{.Name}} {{len .Containers}}'
```
**B. 停写（各一条，按核实结果填）**
```
systemctl stop <Front Claw launcher 单元>      ; systemctl disable <同单元>   # 停与禁用分开批
systemctl stop <外层 pilot 单元>               ; systemctl disable <同单元>
docker stop <Front Claw 业务 worker 容器完整ID>
systemctl stop <Mem0 单元1..3，核实后>          ; systemctl disable <同单元>   # 仅在确认 Mem0 调用已关闭后
```
**C. 迁移（在专用 Front Claw PG 上；源 = 已授权导出并恢复到隔离库的副本）**
```
export FRONT_CLAW_MIGRATE_SOURCE_URL=<隔离副本库URL>  FRONT_CLAW_MIGRATE_TARGET_URL=<OpenDot侧 Front Claw PG URL>
node dist/migration/cli.js schema-status
node dist/migration/cli.js schema-up            # dry-run，看输出
node dist/migration/cli.js schema-up --apply
node dist/migration/cli.js preflight            # blocking 必须为空
node dist/migration/cli.js import --source-label=<副本标识>            # dry-run
node dist/migration/cli.js import --apply --source-label=<副本标识>
node dist/migration/cli.js postflight           # 必须 ok:true
```
**D. 回退（按需）**
```
# R1 同库：先完成 B 的停写
node dist/migration/cli.js schema-down ; node dist/migration/cli.js schema-down --apply
<按原方式启动 M07 制品>
# R2 新库：
export FRONT_CLAW_MIGRATE_ROLLBACK_URL=<新建空隔离库URL>
node dist/migration/cli.js export-rollback ; node dist/migration/cli.js export-rollback --apply
```
**E. 清理（切换验证完成后单独批）**
```
docker run --rm -v qiwe-frontagent-existing-b58d72d3-4908-45cc-9bf8-a268bfcf79d3:/v:ro -v <备份目录>:/b <核实镜像> tar czf /b/b58d72d3-<日期>.tgz -C /v .   # 先备份并验证可恢复
docker volume rm qiwe-frontagent-existing-b58d72d3-4908-45cc-9bf8-a268bfcf79d3   # 仅当 A 显示无引用
docker network rm <b419d41c完整ID>                                              # 仅当端点数为 0 且确认不是共用 DB 网
```
- r6 `26e0d23c`、r9 `6d2c609d` 只有前缀，不列入。
- Mem0 数据和向量库没有确切对象，不列入。

**需你另行决定、不在可批清单里**：
- 历史测试行（草稿 1、目标 1）在 `legacy_appointment_db.front_claw_perf`，位于共用 PG。按本次“永不针对共用 PG”的规则，不给可执行命令。主键也未知。
- 同理，要导出旧库副本作为迁移源，也必须碰共用 PG，需要你另行明确授权方式（例如由你方 DBA 导出）。

## 6. 未验证
- **线上 PG 版本未知，待确认**；所有 PG 结果都来自 PG17.11 临时集群，**它不是线上版本**。没有任何延迟或耗时达标的结论。
- 没有真实数据副本，全部是合成数据。不能宣布真实数据已迁完；真实的金额、门店、状态分布未对账。
- OpenDot 目标 SHA 未知；OpenDot SQLite 69→107 的实际迁移本片没有跑。旧业务 SQLite（ManagerStore）的内容和去留未知。
- 历史库是否有当前 schema 以外的列或约束未知。preflight 会报形状问题，但没有对真实库跑过。

## 7. 已知限制
- schema-down 时若还有 v8 实例在跑，其取件查询会失败，所以必须先停写。
- schema-up 的 dry-run 也会短暂拿 DDL 锁。
- 畸形 pending 行在 v8 下不会到期（v7 下实际也不会被派发），由预检列出。
- 导入时仍未结的草稿不再提醒，这是有意设计：历史提醒不重发。
- postflight 的严格模式只适合导入刚结束时用；营业后复核要加 `--allow-changed`，被改的行会计数但不判错。

## 8. 待你决定
1. 线上 PG 版本，以及迁移源副本怎么产生（谁导出、导到哪）。
2. 第 5 节的对象核实与逐条批准，以及共用库测试行是否处理。
3. 默认值 D51–D62 是否接受：尤其是 008 手动执行、历史 pending 一律抑制、未结草稿不补提醒。
4. 回退选 R1 还是 R2 作为默认。
