# M01 实施报告

日期：2026-11-11。结论：**本地受控员工闭环已实现并完成替身验证；未提交、未部署，不作为真实 PG/企微上线验收。** 专项与相关回归通过；全量仍失败，原因及同环境基线对照见下文。

## 版本与制品

- 仓库：`<本地路径>`；分支始终为 `migration/m01`。
- 实际 base：`f2a8105acf84ac0679b3a0f4b86c973d03e1781a`。实际 Git HEAD 仍为同一 SHA，未生成新提交。
- 未提交 head 的可复核表示：**base + [m01.patch](m01.patch)**。
- `m01.patch` SHA256：`7819d48effd4d053ae327ca49d083cd005bae9921ac069d0ac57d661f1eba31e`。
- 已执行用户指定的 `git add -N .`（仅 intent-to-add），再执行 `git diff --binary f2a8105acf84ac0679b3a0f4b86c973d03e1781a > <本地路径>`；`sha256sum`、`git diff --check` 均成功。补丁共 15 文件，已核对不含 node_modules、package.json、package-lock.json 或构建产物。
- [ISSUE.md](ISSUE.md) 与 [PLAN.md](PLAN.md) 在代码修改前写入；[BASELINE-ALIGN.md](BASELINE-ALIGN.md) 和 [baseline-provenance.json](baseline-provenance.json) 记录片内 G/L/F 依据。d05d316c 是现场 marker，不冒充 Git SHA 或完整对齐后的 head。

## 实际改动文件

| 文件 | 改动 |
|---|---|
| 新增 `src/role-eval/employee-loop.ts` | 标准清单、别名、完整目录与本人范围；草稿绑定账户/成员/会话/绑定版本/内容版本；消息与操作查回；受控写开关；只读进度；最终回复与生成时延钩子 |
| `src/role-eval/performance-store.ts` | 可选 employeeContext、只插不覆盖、待确认版本条件转换、按人/店过滤草稿；同步内存接口供既有测试使用 |
| `src/role-eval/performance-postgres.ts` | 复用草稿/entries 事务；先成功转换 confirming 状态再插 entries；新增条件更新和只插不覆盖 SQL；失败回滚 |
| `src/role-eval/wecom-bot-unified-handler.ts` | 显式选择窄入口；旧 handler 不维护或确认带员工上下文的草稿 |
| `src/role-eval/wecom-bot-handler.ts` | 传递可信 message/session/bindingVersion；受控文本优先于旧 SQLite 命令；消息指纹先于业务准备；允许已授权普通员工进入本人路径 |
| `src/role-eval/wecom-bot-assembly.ts` | 受控模式沿原可信成员鉴权，不额外要求 manager；固定装配时端口快照 |
| `src/role-eval/wecom-bot-delivery.ts` | 沿原全局指纹重放确定答复，避免旧“对”确认后来新草稿；未知业务结果沿原 PG 操作恢复 |
| `src/role-eval/front-claw-boot.ts` | 受控模式必须 PG；初始化失败收尾、关闭幂等；remember 仅核对既有完整档案，不自动造人 |
| `src/role-eval/performance-open.ts` | 显式 requirePostgres；采用 L7 的 pool.end 幂等行为 |
| `src/role-eval/wecom-bot-pilot.ts` | 采用可证 L5/L7 先库后连接、转发端口及关闭修复；M01 也走该 PG 准备路径 |
| 新增 `tests/role-eval/employee-loop-m01.test.ts` | 12 项员工闭环/负例/恢复/版本/SQL 原子性与证据输出 |
| 新增 `tests/role-eval/employee-loop-lifecycle-m01.test.ts` | 3 项 PG 打开失败、重复关闭、同替身库重开；Pool 完全替身 |
| `tests/role-eval/store-entry.test.ts` | 新增 1 项 SDK→可信绑定→全局指纹→PG 的同请求组合测试；仅员工权限、不写旧业绩、跨新旧路由消息冲突零准备 |
| `tests/role-eval/wecom-bot-pilot.test.ts` | 新增 M01 缺库在连接前拒绝与幂等关闭测试 |
| `tests/role-eval/wecom-bot-real-pilot.test.ts` | SDK 为离线替身；新增 L5/L7 构造/prepare/关闭测试；旧缺库测试由“构造抛错”改为“prepare 拒绝且连接次数为 0” |

没有修改原解析器、目录存储、本人进度工具或 schema；复用原 `confirmEntryId` 和业务事务。没有安装依赖、改 lock、改输入证据包、删除既有文件或清数据。

## 验收逐项对应

| 场景 | 实际证据 |
|---|---|
| 小林/测试A店、小陈同店、小王/测试B店、林林→小林 | 新增员工闭环固定合成目录，别名保存到 PG store 的 SQL 替身 |
| 标准清单报 380→回显→对 | 确认前 entries 空；确认后仅 1 行、金额 380；回显含小林、测试A店、380 |
| 重复“对”、原报数/确认消息 ID 重发 | 比较完整 entries/drafts 快照不变；原确认重放不确认后来新草稿 |
| 无草稿、取消后“对”、空名/空门店/未绑定 | 全部比较 entries/drafts 前后相等；没有调用模型 |
| 他人、他店、他人员工内容、另一会话、旧绑定版本 | 零入账/零草稿改变；按他人操作号查询不返回金额；无指定他人进度能力 |
| 提交后回包前中断 | onOutbound 注入异常发生在事务提交之后；原报数 ID、确认 ID、操作号均可查原结果；重放不增账 |
| 新建 store/handler、“重启” | 同一个 MemorySql 数据库对象，新建 PG store 和 handler；本人进度仍为 380，同店另一员工不看到该 380 |
| 库故障 | entries INSERT 故障回滚；原确认关联保留；恢复后重试原消息恰记一次；读故障返回结果未知；缺 URL/开库失败不退回内存 |
| 仅受控成员、关闭/坏配置 | 配置只开放 A 店名单；关闭、空名单或坏 JSON 时新报数/确认/取消均不改 entries/drafts，已有账与草稿保留；本人读仍可用 |
| 旧入口与全局指纹 | 同一 SDK 请求穿过装配/鉴权/port/PG；新旧路由复用同 ID 改文案时，remember 未调用、PG 不变；旧 SQLite 业绩明细/金额不增 |
| 版本与 PG 防误写 | 错版本条件更新不命中；ifAbsent 不覆盖；无认领状态 commit 不插 entries；旧 handler 的维护/确认/取消不处理受控草稿 |

完整实测快照见 [employee-loop-evidence.json](employee-loop-evidence.json)，直接从专项原始 stdout 提取，没有手填结果。该次两条 messageId 分别是 `evidence-report` / `evidence-confirm`，共同 operationId 为 `d431a6179690e1cb109a615b0f624afdde568de062885583fd4cffeced56236e`；回复生成时延分别约 **0.656 ms / 0.218 ms**。样本量为 2、SQL/SDK 均替身；这不是平台投递/手机实收时延，也不是 P95 或生产 SLA。

## 命令与结果

执行目录均为 repo，B 同环境对照除外。npx/npm 使用 `npm_config_offline=true`；Vitest 的 `TMPDIR=<本地路径>`。输出都按 `; echo "exit=$?"` 追加实际测试退出码。所有最终及中间命令的**完整参数、退出码、计数与原始日志**见 [test-output/COMMANDS.md](test-output/COMMANDS.md)。

| 最终命令 | 退出码 | 结果 / 原始输出 |
|---|---:|---|
| `npx tsc --noEmit` | 0 | [tsc.txt](test-output/tsc.txt) |
| `npx vitest run tests/role-eval/employee-loop-m01.test.ts --silent=false --reporter=verbose` | 0 | 1 文件、12 通过；[专项日志](test-output/employee-loop-m01.txt)；显式打开 stdout 以保留完整快照 |
| `npx vitest run` 后跟 13 个相关测试文件（完整命令见命令索引） | 0 | 13 文件、175 通过；[regression.txt](test-output/regression.txt)；含全部用户指定六文件以及 lifecycle、directory、pilot、delivery、assembly、handler |
| `npx vitest run` | 1 | 66 文件：61 通过/5 失败；794 用例：786 通过/8 失败；[full-vitest-final.txt](test-output/full-vitest-final.txt) |
| `npm test` | 1 | 同为 786 通过/8 失败；[npm-test.txt](test-output/npm-test.txt) |
| `npm run typecheck` | 0 | [typecheck.txt](test-output/typecheck.txt) |
| `npm run build` | 0 | [build.txt](test-output/build.txt) |
| B 同环境对照：`npx vitest run` 后跟 5 个失败文件 | 1 | 56 用例：48 通过/8 失败；[baseline-sandbox-comparison.txt](test-output/baseline-sandbox-comparison.txt) |
| `npm run test:pg` | 未运行 | 无可用 Docker daemon，本次不得连接既有 PG，真实 PG 标未验证 |

过程记录：初始新增 8 例为 1 通过/7 失败；修复后转绿。另加“仅员工权限”组合反例，先失败，再修复 assembly/handler 两级门禁后通过。中间两处回归失败分别是预期变化（缺库从构造期改到 prepare）和测试比较了会变化的 observedAt，均有单独日志；没有删除或跳过最终测试来换取通过。

### 与基线比较

调度方提供基线为 **64 文件、776 用例，774 通过/2 失败**，两项均为 `tests/native/live-model-smoke.test.ts`；原日志保留在 `test-output/baseline-f2a8105-*.txt`。

本次最终全量为 **794 用例（增加 18）、786 通过/8 失败**。不能把额外六项笼统算成原有那两项：在当前沙箱，最小 `node:child_process.spawnSync(process.execPath, ...)` 探针也返回 `EPERM`。为验证归因，从 B 导出 227 个源码/测试/配置文件到 `M01/baseline-check`，排除 env/凭据类文件名及 lock，仅链接已有依赖；**未切换 repo 分支**。对相同五个失败文件复跑，八个失败名称全部复现，并用脚本比对两个失败集合相等。

| 失败文件 | 数量 | 证据解释 |
|---|---:|---|
| tests/native/live-model-smoke.test.ts | 2 | 调度方已记录的基线失败，本次未修 |
| tests/role-eval/local-performance-output.test.ts | 1 | 子进程 spawnSync EPERM，同环境 B 复现 |
| tests/role-eval/manager-artifacts.test.ts | 1 | 子进程输出为空导致 JSON 解析失败，同环境 B 复现 |
| tests/role-eval/wecom-bot-sqlite-contention.test.ts | 2 | 合成持锁子进程未就绪，同环境 B 复现 |
| tests/role-eval/wecom-bot-task-store.test.ts | 2 | 两项独立进程重启检查 spawnSync EPERM，同环境 B 复现 |

因此本次未观察到 M01 引入的新失败；**全量并未全绿，六项进程相关验证受当前执行环境限制**。没有修改这些失败测试或业务源码来绕过环境。

## 开关、兼容和交接

装配通过 `employeeLoop: true` 选择 M01 窄入口，boot/pilot 必须提供 PG URL；本地测试使用假 URL 和 Pool/SQL 替身。原 `isolated-synthetic` 限制保留。人员须先存在且完整、绑定须来自原可信 SDK 上下文；聊天正文不能创建人员或指定操作者。

真正的业务写开关是 PG config 键 `employee-loop:m01`。合成测试示例为：

```json
{"enabled":true,"storeId":"s-a","memberIds":["m-lin","m-chen"]}
```

关闭用同一 config 的 `enabled:false`，或空名单/缺失/非法配置都拒绝新写。**关闭时保留 `employeeLoop:true` 的入口装配；不要把它改为 false 当作业务关闭**，因为未选择 M01 的旧路径为兼容而保留。没有向任何真实配置写入上述值。

草稿不原地编辑；M01 允许取消后另发标准清单，确认严格以原会话/绑定版本为界。重复消息用 ID 识别，不按“姓名+金额”去重，不吞掉不同消息表示的合法同金额业务。多张并发待确认草稿保守拒绝无对象确认，完善选择/编辑交后续切片。

- **M02（路由扩展）**：接完整自然语言、姓名引导、同义词、复合意图、显式营销及统一预算；保持 message/session/operation 关联与全局指纹先行。当前未知文本只引导，不调用模型；需把回复生成时延扩展到实际投递。
- **M03（正式权限）**：接三角色/门店集合/策略版本、执行与发送前统一鉴权、撤权和提交的事务顺序。首片已有本人边界，但没有声称完成并发撤权或通用 IAM。不得靠修改聊天正文或 owner 临时名单提权。
- **M04/M06/M07/M09**：增量清单、更正/目标、可靠提醒、历史数据与真实宿主生命周期另做；受控草稿的关闭保留语义不可被旧维护恢复破坏。L8/L9 的 runner/模型不在本补丁。

## 限制、未验证项与待决定事项

1. 真实 PostgreSQL 的锁竞争、跨进程崩溃、连接丢失和事务持久性**未验证**。MemorySql 只执行仓库用到的有限 SQL 形状；本片“重启”是同一替身数据库的新实例，不是真实数据库重启。
2. 真实企微、主动通知、手机结果、业务服务器、远程数据库、真实模型、OpenDot 全部**未接入/未验证**。SDK 组合测试和名称含 real-pilot 的用例使用离线 SDK 替身。
3. d05d316c 逐行对齐缺口仍在；F 完整 handler diff/测试源码和日志缺失。仅核对本片 L5/L7，不代替现场完整清单。
4. 本机依赖由调度方以 `npm install --no-package-lock` 预装；**f2a8105 的 package-lock.json 与 package.json 不同步是已知基线问题**。本次未安装或改两文件，构建通过不等于 lock 可复现安装验证。
5. 首片仅受控入口，没有退出全库所有历史高级业务入口；装配必须保持 M01 路由锁定。PG 配置开关与提交的跨进程并发顺序留 M03；无限挂起的数据库 Promise、硬截止和取消收敛留 M02/M09。
6. 未做第二位审阅者的独立复核。本次完成了终稿差异复核、拒绝副作用检查、最终命令复跑和失败集合对照，不能冒称独立人工审阅已完成。
7. 测试仅使用合成身份、假值和本地夹具；未读取既有业务 env/真实凭据。仓库全量测试自身会创建并读取临时合成 `.env` 夹具（live-model-smoke，值为 synthetic-key），它不代表访问了真实配置。所有本次测试临时根限定在工作区；未操作运行中服务或既有业务数据。

没有阻塞本次本地交付的待决定项。后续正式试用需用户决定受控成员/门店名单、测试环境及账号和开放时间，并补真实 PG/企微验收。并发多草稿的选择/作废方式、代报是否开放和正式权限策略分别交 M02/M03/M04 决定；本片代报保持拒绝。

## 产物索引

- [ISSUE](ISSUE.md)、[PLAN](PLAN.md)、[片内基线对齐](BASELINE-ALIGN.md)
- [补丁](m01.patch)、[文件清单](changed-files.txt)、[最终 git status](final-status.txt)
- [完整命令索引](test-output/COMMANDS.md)、[合成闭环观测快照](employee-loop-evidence.json)
- `baseline-check/` 为本次同环境 B 对照副本，`tmp/` 为测试专用临时根；均在 M01 下，不在补丁中。
