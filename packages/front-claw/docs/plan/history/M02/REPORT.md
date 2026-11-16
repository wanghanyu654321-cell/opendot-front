# M02 实施报告：路由纠偏与响应预算（含同店代报）

日期：2026-11-11（UTC+8），完成于 18:24。结论：**本地实现完成；MemorySql 替身和本机 PG17 临时集群上验证通过。未提交，未部署，未接真实模型、企微或线上 PG，不能作为上线验收。**
分工：助手A侧写代码，助手B审查（用户 18:07 决定）。流程按 WORKFLOW §2.1–2.4、§6.3；ISSUE.md / PLAN.md 在改代码前写好。

## 1. 版本与基线

- 原仓库 `<本地路径>` 没有动：分支仍是 `migration/m01`，HEAD 仍是 f2a8105，未提交 diff 的 sha256 仍是 `7819d48e…a31e`，和 M01/m01.patch 一致（开工时和收尾时各核对一次）。
- M01 快照：`m01-snapshot/`，内含 m01-working.diff（与 m01.patch 同 hash）、git-status、HEAD、15 个文件副本及 files.sha256。
- M02 工作树：`<本地路径>`。做法是 `git worktree add --detach` 拉出 f2a8105，再 `git apply` m01.patch；新文件用 `git add -N` 登记。没有 commit，没有 stash，没有建分支。node_modules 是从原 repo 拷来的，没有联网安装。
- 副作用说明：
  - 原 repo 的 `.git/worktrees/` 里多了这个工作树的登记。
  - 生成增量补丁时，用临时索引写了一个 M01 树对象 `dc1e6f4b…`（m01-tree.txt）。它是 .git 里的松散对象，没有 ref，也没有 commit。
- 实际基线：base = f2a8105 + m01.patch。d05d316c 的完整逐行对齐仍沿用 M01 的结论（未做）。

## 2. 改动文件（相对 M01 的增量：17 个文件，+1019/−28）

| 文件 | 改动 |
|---|---|
| 新增 `src/role-eval/intent-router.ts` | 规则快路径分类，是纯函数，不碰 store。分九类：report/followup/progress/result/appointment/summary/chitchat/marketing/clarify。出现多个意图就判澄清。`decideRoute`：营销只在“明确营销意图 ∧ 已启用 ∧ 获权”时进入。`classifyWithSemantic`：可选，至多调一次，有截止时间和取消；输出畸形、置信度低于 0.8、越界、超时、抛错时一律保持澄清。 |
| 新增 `src/role-eval/request-budget.ts` | 统一截止时间，默认 15 秒。终态只有 completed/failed/timeout/cancelled 四种，只结算一次。迟到的结果只回调记录，不再投递。同号同内容的请求，进行中的共享结果，已完成的复用终态（duplicate）。同号不同内容的不复用。非 completed 的终态不缓存，所以重发原消息还能续上业务。最终回复按“请求号＋终态＋文本”只投递一次。 |
| 新增 `src/role-eval/route-log.ts` | 分 inbound/classify/commit/deliver 四段，记录 requestId、相对入站的毫秒数、结果、标签和目标，不记正文。sink 抛错不影响业务。 |
| 新增 `src/role-eval/employee-entry.ts` | 包在 M01 员工入口外层：先分类决策，再按结果分发——店务交 M01；闲聊本地回复；营销走可选端口，端口拿不到 store；其余澄清。外层负责统一预算、唯一终态、去重投递和日志。店务超时的回复是「结果未知，请发『入账结果 <原消息号>』」。 |
| `src/role-eval/wecom-bot-unified-handler.ts` | `employeeLoop: true` 时改走 `createEmployeeEntry`。M01 入口不再自己调 onOutbound，改由外层去重后投递一次。新增 `router` 选项；HandleResult 加了几个可选字段：requestId/state/target/duplicate。 |
| `src/role-eval/employee-loop.ts` | **同店代报**：括号里的员工必须能在本店唯一匹配到在职、档案完整的人员（按姓名或别名），业绩记给这个人，reporterPersonId 记发送人，回显注明“同店代报”。跨店代报，包括他店门店名、他店员工和查无此人，一律拒绝且零写入。草稿里存条目摘要 `itemsDigest`，确认前重新核对摘要，并核对对象仍是本店在职人员。没有摘要的 M01 旧草稿仍然只允许本人确认。DENIED 和引导文案也改了。 |
| `src/role-eval/performance-store.ts` | EmployeeDraftContext 加两个可选字段 `itemsDigest`、`proxy`。都存在 payload_json 里，PG schema 不变。 |
| `src/role-eval/wecom-bot-conversations.ts` | 岗位对话：`pickAutoRole` 不再把营销当兜底，闲聊有 reception 就交 reception，否则本地回复；选岗回退顺序去掉了 marketing；`route()` 加营销闸门，店务、闲聊、多意图都不提交到营销岗位，只有已在营销上下文里的不明确跟进（如“再来一条”）才允许继续；没有 current 也没选中岗位时，本地回复澄清，不再提示“岗位 内容营销”。 |
| **单列：`tests/role-eval/performance-postgres.integration.test.ts`** | **只改一行**：`const bin = process.env.FRONT_CLAW_PG_BIN?.trim() \|\| '/usr/lib/postgresql/16/bin';`。不设变量时默认路径和原来完全一致（test-pg-default.txt 实测报 `/usr/lib/postgresql/16/bin/initdb ENOENT`）。测试仍自建、自删临时集群，走随机端口，不连 55432 常驻库。 |
| 新增测试 | `intent-router-m02.test.ts`（7 项）、`employee-entry-m02.test.ts`（10 项）、读取评测语料的测试（1 项）、`employee-loop-pg-m02.integration.test.ts`（3 项，真实 PG）、调参语料。 |
| **改了旧测试的断言（行为按需求改变）** | `wecom-bot-auto-role.test.ts`：原先断言“你好”回落营销、单一营销授权时“投放预算”进营销、手动选营销后“你好”进营销，现改为不进营销。`wecom-bot-report-confirm.test.ts`：两项原断言“不完整报数 / 模型抽取失败时回落到会话”，在该测试里就是只授了营销的会话，即报数落营销，现改为不提交、零保存。共 6 处断言，详见 m02.patch。 |

没有改 package.json、lock、schema，也没有改 M01 的两个测试文件。

## 3. 命令与结果

完整命令见 [test-output/COMMANDS.md](test-output/COMMANDS.md)。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm exec --offline -- tsc --noEmit` | 0 | — |
| M01 回归：`vitest run employee-loop-m01 + employee-loop-lifecycle-m01` | 0 | 15/15 |
| M02：私有评测语料 | 0 | 18/18 |
| 相关回归（12 个文件） | 0 | 160/160 |
| 全量 `vitest run` | 1 | 812 个用例：810 通过，2 失败。失败的只有 `tests/native/live-model-smoke.test.ts` 两项，基线就有。M01 报告里沙箱下的 6 个 EPERM 失败这次没有出现。 |
| `FRONT_CLAW_PG_BIN=…/pg-temp/root/usr/lib/postgresql/17/bin npm run test:pg` | 0 | 11/11（原有 8 项 + 新增 3 项）；并发用例另外重复跑 5 次，5/5 通过 |
| `npm run test:pg`（不设变量） | 1 | 预期失败：默认找 PG16 路径，本机没有 |
| `npm run typecheck` / `npm run build` | 0 / 0 | — |

**真实 PG 用例（PG 17.11 用户态临时集群，不是线上版本；线上版本未核实，原测试写的是 PG16）：**
1. M01：确认前 entries 为空；确认后正好 1 笔 380。之后发新消息号的“对”、重发原确认号、重发原报数号，都不再加账。草稿状态为 confirmed。
2. M02：同店代报 560 记给小赵（owner=p-zhao，reporter=p-wang-yj）。跨店代报（他店门店名、他店员工）回复“跨店不能代报”，PG 前后快照一致。
3. 并发：两个独立连接池各配一个 handler，同时对同一张草稿回“对”。只入账一笔 420。另一方确定地得到「草稿版本已变化，请查原操作结果」，不是“结果未知”，也没有挂起（耗时 <10 秒）。另外在存储层，两个连接同时对同一条已认领草稿 `commitConfirmingDraft`，靠状态条件更新加 entry_id 唯一约束（ON CONFLICT DO NOTHING），只落一笔，两边都返回 1。

**故意改坏代码的反向验证：**
- 把闲聊临时改成路由到营销，M02 测试 2 项失败。
- 去掉代报摘要和对象校验，M01 的“伪造他人员工草稿”和 M02 的“摘要不符”两项失败。
- 两次都已改回，最终代码以补丁为准。

## 4. 语料指标

文件：私有评测结果，内含每类 P/R/F1 和混淆矩阵。

| 集合 | 条数 | 宏 F1 | 准确率 | 预测澄清率（金标澄清占比） | 店务误入营销 | 闲聊误入营销 |
|---|---:|---:|---:|---:|---:|---:|
| 调参集 tune | 55 | 1.00 | 1.00 | 14.5%（14.5%） | 0 | 0 |
| 留出测试集 | 52 | 1.00 | 1.00 | 19.2%（19.2%） | 0 | 0 |

- 合计 107 条，两集文本没有重复。盲测集，18:13 先冻结，再写分类器；18:16 只跑了一次就是 52/52，记录见留出测试集产物，之后规则没再改。
- **满分不能说明泛化能力。** 两集语料和规则是同一个作者写的，不算独立盲测。另外拿 12 句没见过的说法试了一下（probe-unseen.txt）：9 句落到“澄清”，比如“今天卖了三单”“帮客户写个感谢短信”“把刚才那笔改成600”；“朋友圈怎么发报数”判成多意图。**没有一句误入营销**，但规则召回明显偏低。设计取向是宁可澄清也不误路由。
- 指定场景都在测试里：“帮我写今天报数清单”判报数，进店务；“预约明天下午3点张三”判预约；无序号确认（对 / 对的 / 确认 / 好的）判跟进；“客户名＋员工名”判报数；复合意图判澄清。
- 时延只有本地替身数据：MemorySql 加进程内调用，100 个样本，P50 约 0.24 ms，P95 约 0.38 ms，最大约 1.36 ms（每次运行会有波动，见 m02.txt）。**不是真实 PG、模型或企微投递时延，不标达标**；“P95≤2 秒、15 秒内必有结果”这两条门槛仍未验证。超时路径用 80 ms 预算实测，<180 ms 内给出唯一的 timeout 终态。

## 5. 未验证项

1. 真实模型：语义分类端口默认不装配，只用桩函数测了超时、畸形输出和取消的处理。模型的准确率和时延未测。
2. 真实企微投递、手机端实收、真实营销 Runtime 都未接，营销端口只在测试里注入。
3. 线上 PG 的版本和配置未验证，本次是 PG17 临时集群。跨进程崩溃、断连这类真实故障没注入过。
4. 请求登记和投递去重只在进程内有效。重启后的去重靠 M01 的 PG 草稿、操作号和全局指纹，“新实例收到同一个已完成请求”时的投递去重没单独测。
5. 超时以后业务 Promise 不能硬中断：子 signal 一停，M01 入口在写库前会拒绝新写，但已经进了事务的会照常完成，可以按原消息号查回。
6. 岗位对话的营销闸门只在单元层（auto-role、report-confirm）验证过，没有在真实 Native 会话上验证。M03 的正式授权接入后要组合复测。
7. 没有第二位审阅者，等助手B审。d05d316c 的完整对齐仍缺。

## 6. 给助手B的审查要点

1. **营销闸门语义**：手动选了营销岗位后，不明确的文本（如“顾客问营业时间”）仍然提交到营销；闲聊、店务、多意图不提交。这个取舍是否可以接受？
2. **闲聊去向**：岗位对话里闲聊交给 reception；没授 reception 的，本地回复，不进其他岗位。这样是否合适？
3. **代报对象范围**：被代报人只要是本店在职、档案完整的人员即可，**不要求**在 `employee-loop:m01` 的受控名单里。是否要求被代报人也在名单内？
4. **代报防篡改**：用条目摘要（sha256，不加密钥）防止 DB 里的草稿条目被改写；无摘要的旧草稿只允许本人。威胁模型是否足够？
5. **请求预算缓存策略**：只缓存 completed，timeout/failed/cancelled 不缓存，这样重发原确认可以续上。这样是否会造成“同一请求先回结果未知、后回已入账”两次投递？目前的设计认为两次都该投递。
6. **规则召回**：盲测是同一作者写的，未见句大多落澄清。建议助手B另写一份独立盲测语料，或者决定是否启用语义端口。
7. 旧测试的 6 处断言改动是否都属于“修缺陷”，有没有误伤正当行为。
8. 并发用例输方的回复是「草稿版本已变化」还是「没有待确认」，取决于时序，两种都算确定结果。这个口径是否可以接受？
9. test:pg 的 FRONT_CLAW_PG_BIN 一行改动（默认值不变）。

## 7. 需要用户或助手B决定的事

- 营销能力什么时候开：`router.marketing.enabled` 默认不装配，等于营销不开。首批 B 店要不要开营销，开给哪些人（看 marketing 授权）？
- 被代报人要不要也在受控名单内（审查要点第 3 条）。
- 要不要接真实模型做语义分类（默认关，只用规则加澄清）。
- 首批试用：B 店，测试员工A测试账号。本片只在测试里用了合成占位名，**没有写入任何真实配置**。
- 时延门槛要用真实环境复测，测试环境需要用户批准。

## 8. 产物与 sha256

见 [SHA256SUMS](SHA256SUMS)。主要产物：
- `m02.patch`：相对 base + M01 的增量。
- `m02-cumulative.patch`：相对 f2a8105 的累计。
- 两条路线已校验等价：在 f2a8105 干净导出上，先打 m01.patch 再打 m02.patch，和直接打累计补丁，结果逐字节一致。
- 其他：ISSUE.md、PLAN.md、私有评测语料、校验文件、留出测试集产物、probe-unseen.txt、changed-files.txt、final-status.txt、m01-tree.txt、test-output/、m01-snapshot/。
