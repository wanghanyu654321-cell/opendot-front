# R3 报告（2026-11-12，UTC+8）

- 起点：R2a 树 `6fcd27659ce4d7c149a8a4887e72c7ebc284d9c0`；基线 G = commit `f2a8105acf84ac0679b3a0f4b86c973d03e1781a`（tree `9ef2bbe9aca49c938277755f76c6ac6915978459`）
- **R3 新树：`9ecf70526275b989ded98922c711efe22ba1d093`**（repo-r3 里 `git add -A && git write-tree`；未 commit、未 push）
- `r3.patch`（6fcd2765 → R3，2436 行）、`r3-cumulative.patch`（G → R3，16109 行）。两份都用临时 GIT_INDEX_FILE 做过 `read-tree 起点 → apply --cached → write-tree`，结果都是 `9ecf7052…`
- 依据：助手B复审记录。复现用例私有评测产物原样复制到 `tests/audit/`，其中 3 个 r2a 用例改成断言安全行为（见 §2）；私有评测产物复制到 `R3/audit-copy/`
- 约束遵守情况见 §8

## §0 本轮新增默认值（从 D90 起）

| 编号 | 内容 |
|---|---|
| D90 | **统一的带 epoch 写入口**：`PerformanceStore.saveDraft/transitionPendingDraft/setConfig` 带上 `fence` 时，必须经过 store 内唯一入口 `fencedWrite`。PG 实现分两步，在同一事务里：① 条件锁读租约行（`owner`、`epoch` 相等，`until>now`，`FOR SHARE`），0 行就抛 `FencedWriteRejected`；② 写 SQL 本身再带 `AND EXISTS(租约匹配)`，INSERT 用 `INSERT … SELECT … WHERE TRUE AND EXISTS(...)`。内存实现用同一判定（`fenceHolds`）。消费者模块（员工入口、OpenDot 适配器）只能经过 `consumer-writes.ts`（`createDraft/rewriteDraft/transitionPending/putOperationRecord`），或者经过带 guard 的 `commitConfirming*`（R2 起已带 `guard.fence`）。静态检查 `tests/r3/r3-write-paths.test.ts` 有两条：W1，PG 文件里每条写 SQL 所在的方法都必须登记，未登记就失败；W2，消费者模块不许直接调用 store 的写方法。 |
| D91 | **被接管后的回复**：消费者写入被拒时，员工入口回 `STALE_CONSUMER`（「Front Claw：本实例已不再负责这条消息，没有写入。」），零写入。适配器发回复前会再核一次 fence，旧持有者这时 fence 已失效，所以这句话实际上不会发给员工。操作记录写入被拒，就放弃这条记录，不重试。 |
| D92 | **补偿写不带 fence（有意为之）**：`guardAllows`（入账门拒绝）、`fencedOut`（租约被挡）、`voidConflict`（提交冲突）。它们都在同一事务里，带 `status='confirming'` 条件，只把本次操作自己改出来的 confirming 状态改回去：退回 pending，或者冲突时标 void。不会新增账目。 |
| D93 | **f 只由数据库递增**：领取时应用层写的是不带 f 的模板，PG 在同一条 UPDATE 里做 `f = 旧 f + 1`（`BUMP_FENCE_SQL`），条件是 `f < 999999999999999`。重试回到 queued、not_sent、unknown、人工补发、sent 都原样保留 f，所以 f 只增不减。发送门 UPDATE 的 f 条件保留，并加了注释「拆成结构化列后，f 是主要护栏；前提是任何路径都不让 f 回退」。 |
| D94 | **钩子句柄语义**：`startFrontClawHook` 立即返回句柄，句柄有三个方法。`state()` 返回 'off'、'loading'、'active'、'unavailable' 或 'closed'；`ready()` 在超时或失败时返回 null；`close()` 用于关闭。Front Claw 模块用 `setImmediate` 推迟到 OpenDot 当前启动步骤之后再加载。动态 import、模块初始化、start 三段共用一个超时预算（`FRONT_CLAW_OPENDOT_START_TIMEOUT_MS`）。超时后标 unavailable，并告警 `{alert:'front_claw_unavailable', stage, budgetMs}`；之后迟到的服务会被关掉。`opendot-hook.patch` 已重新生成（132 行），index.ts 部分与 R2a 逐字节相同，只改了 front-claw-hook.ts。 |
| D95 | **越权或跨店直接拒绝**：回「Front Claw：不能做——原因。没有读取或写入任何账目。」，不追问、不读账本、不写入（`scope-refusal.ts`）。三条通用规则，判定依据是人员目录和权限，不是句子关键词：① 文字里出现目录里的他店名称 → 「只能办本店（X店）的事……跨店不能代报，也不能查」；② 查询类说法、不带金额、点名了本店同事，且没有 progress_other → 「你没有权限查同事（…）的业绩，这个需要店长来查」；③ 全店排名或汇总类说法，且既没有 store_summary 也没有 stores_ranking → 「…这个需要店长来」。两个触发位置：路由本来要澄清时；M01 入口只回通用提示（`REPORT_HINT`，零写入）时。已有的结构化命令（如「小钱的进度」「经营汇总 X店」）保持原来的非枚举拒绝（「查不到，或你没有权限查看」），策略缺失时仍是 ACCESS_DENIED。 |
| D96 | **复合句**（报数 +「再/然后/顺便…」接第二件事）：报数照常出待确认清单，仍然要回「对」才入账。后半句如果是「查本人今天/本月的进度或已入账」，就按 progress_self 权限查，结果附在回复里，并注明上面这笔还没确认、不算在内。后半句如果是别的事，就明说「后半句「…」这次没有办：一条消息只办一件店务，请单独再发」。后半句带数字的，算报数的一部分，不另判。 |
| D97 | **盲测分类补充**：「不能做——」和 D81 的「（评测原句已删）」都算拒绝（deny），零写入。① 按严格口径算（整句里的动作都办完），留出测试集产物复算。 |
| D98 | **同步死循环属于已知剩余 P2，未验证可用**：模块初始化里出现同进程同步死循环，会占死事件循环，OpenDot 也一起失去响应，计时器和告警都不会触发。子进程测试 H3 证明了会卡死。要隔离只能用 worker 线程或子进程，留到真实 OpenDot 验收时再定。 |

## §1 已有条目的更正

- **D78（更正）**：R2 的说法「全部写入已 fenced」不准确，**撤回**。准确的范围见 §3 写路径清单。fenced 的是消费者自有的全部写入：草稿新建、覆盖、状态变更，四种提交，操作记录。补偿写（D92）、派发器写（M06 自己的 f 租约）、管理/导入/旧入口写（OpenDot 装配下不可达），都不带消费租约 fence。
- **D81（补充，已定口径）**：只收今天的单。非今天的报数统一回「目前只能报今天的单，补报请找店长」，不追问。适用于两种说法：自然句里出现昨天、前天、上周等，或者清单标题的日期不是今天营业日。之前「历史日期请发带日期标题的清单」这条路已经关闭。**是否开放补报待 hanyu 拍板。**
- **D83（更正）**：跨店点名仍然一律拒绝。M01 入口原有的 DENIED 不变，统一入口另外按 D95 给出原因。指标分开报：「没有误执行」和「全部正确拒绝」是两个数（见 §5）。R2a 时前者是 9/9，后者只有 5/9，不能写成「全部正确拒绝」。
- **D84（更正）**：单笔 100 万、目标 1 亿的上限是占位；「超过 5 万多确认一次」也**待 hanyu 拍板**。本轮**没有实现** 5 万档。
- **D85（改为已定）**：30 分钟未确认提醒发给报单人本人，**不分档位**，员工、店长、老板都发。排队以后报单人的身份行变了（例如被升为店长），发送前按当前身份重判，不发旧提醒。这一条走入口门的 actor_changed 判定，不是按档位过滤。

## §2 问题对照（修前失败 → 修后通过）

修前证据的做法：把 6fcd2765 用 `git archive` 展开到 `R3/tmp/base`，只把新测试和更新后的 `sql-fixture.ts` 拷进去跑。结果见 `test-output/prefix-r3-unit.txt`（17 个失败）和 `prefix-r3-pg.txt`（4 个失败）。审计原始复现在 `prefix-audit-unit.txt` / `prefix-audit-pg.txt`。

| 问题 | 做法 | 用例 | 修前（6fcd2765） | 修后（R3） |
|---|---|---|---|---|
| A-P1-1 旧消费者被接管后仍能写 | D90/D91/D92 | `audit-r2a-stale-writes`（单测 + PG，两个都改成安全断言）、`r3-stale-consumer` S1/S2、`r3-memory-fence` S3、`r3-write-paths` W1/W2、`r1-pg` a4 | 审计 PG 2 失败（stale create/cancel 写进去了）；单测 2 失败；S2、S3、W1、W2 失败（S1 修前就通过：提交本来就有 fence） | 全部通过 |
| A-P1-2 启动超时没覆盖 import | D94 | `audit-r2a-startup`（改成安全断言）、`r3-hook-startup` H1（真实钩子 + 合成异步卡住模块，同进程）、H2（子进程，异步卡住） | 失败：钩子要等 import，宿主被卡住 | 通过：钩子立即返回，宿主计时器照常跑，超时后标 unavailable 并告警 |
| 同步死循环 | D98 | H3（子进程） | —— | **只证明会卡死**（心跳停、告警也不触发）。属于剩余 P2，**未验证可用** |
| f 单调 | D93 | `audit-r2a-f-counter`（改成安全断言）、`r3-f` F1（f 依次 1,1,2,2,2,3,3）、F2（去掉原文比对后只靠 f） | 失败：重试/终态把 f 丢回 0 | 通过 |
| 该拒绝却澄清 | D95 | `r3-product` 纯函数、`r3-product-e2e`（**新写的说法**，不用语料原句） | e2e 失败；盲测 4 条是 clarify | 通过；盲测 4 条都是 deny |
| 相关评测条目复合句 | D96 | `r3-product`、`r3-product-e2e` | 失败；盲测后半句被丢 | 通过；盲测两件都办完，报数仍待「对」 |
| D85 提醒 | §1 D85 | `r2-d5`（用例改为不分档位） | 失败 | 通过 |
| D81 非今天的单 | §1 D81 | `r3-product(-e2e)`；`ledger-m04` 的「撤回昨天的报数」改成「今天报、过了营业日再撤回」 | 失败 | 通过 |
| 客套话 | D95 同模块 | `r3-product(-e2e)`；`r1-m02` 2a 改为客套话走规则判闲聊（桩本身仍然恒澄清） | 失败 | 通过；「谢谢啦」→「不客气，有事随时找我。」，「晚安呀」→「辛苦了，明天见～」 |

现有测试里**改了断言**的地方都由本轮决定直接导致：`r1-pg` a4（现在在 pending→confirming 这一步就被 fence 拒，回 STALE_CONSUMER）、`opendot-hook-m07`/`r1-m07`（句柄 API 变了）、`r2-d5` 两条、`ledger-m04` 一条、`r1-m02` 2a，以及 3 个 audit r2a 用例（原来是复现断言，改成安全断言，文件里有 R3 注释）。

## §3 写路径清单（`performance-postgres.ts`，来自 W1 的 REGISTRY；内存 store 同名方法同口径）

| 方法 | 归类 | 是否带消费租约 fence |
|---|---|---|
| saveDraft | 消费者 | **fenced**（fencedWrite：锁读 + INSERT…SELECT WHERE EXISTS） |
| transitionPendingDraft | 消费者 | **fenced**（fencedWrite + UPDATE … AND EXISTS）。例外：派发器维护的「过期作废」调用不带 fence，它带 pending 原版本 CAS，属于 M06 worker |
| setConfig | 消费者（操作记录） | **fenced**（fencedWrite + INSERT…SELECT WHERE EXISTS，0 行就抛错）。不带 fence 的调用只有管理/旧入口 |
| commitConfirmingDraft / Target / Correction / Appointments | 消费者 | **fenced**（guard 快照 + closeConfirming 条件 UPDATE AND EXISTS） |
| closeConfirming | 上面 4 个共用 | **fenced**（fenceClause） |
| guardAllows / fencedOut / voidConflict | 补偿 | 不带（D92：同事务，条件 status=confirming，只回退本次操作） |
| enqueueNotification / claimDueNotifications / beginNotificationSend / transitionNotification / requeueNotificationWithAudit | 派发器 | 不带消费租约；用 M06 自己的领取 token + f + 原文 CAS（D93） |
| updateConfigLocked / insertConfigIfAbsent | 租约/策略本身 | 不适用（就是租约写入，FOR UPDATE） |
| savePerson / saveAlias / importAlias / insertEntries / reviseEntry / saveTarget / claimPendingDraft / confirmPendingAppointment / claimDraftNotice / saveAppointment / insertNotification / updateNotificationStatus | 管理/导入/旧入口 | 不带。OpenDot 装配是 `employeeLoop:true`，`handleMessage` 直接交给员工入口，旧入口不可达 |

非 OpenDot 装配（没有 fence，例如旧企微 pilot）时，`fencedWrite` 直接写，和 R2a 一样。

## §4 验证（`test-output/`）

- tsc / typecheck / build：exit 0（`tsc.txt`、`typecheck.txt`、`build.txt`）
- 全量 vitest：1102 个，1098 通过、2 跳过、2 失败。失败的就是已知的 2 个 `live-model-smoke`（`vitest-full.txt`）
- test:pg（临时 PG17 `pg-temp`，带 AUDIT 环境变量，含审计 PG 用例）：17 个文件、83 个用例全绿。另外整套连跑 5 轮，5/5 全绿（`test-pg.txt`、`test-pg-round1..5.txt`、`test-pg-5rounds.txt`）。整套里包括 r3-f、r2a 发送门、r2-pg、r1-pg、审计 PG、M05/M06 PG 竞态
- 变异检查 `mutation-check.py`：30 个变异，30 个符合预期。28 个被抓到；2 个是预期存活的等价变异：R2-M2a（R2a 结论）和 **R3-M6**（「去掉锁后原文比对和条件 UPDATE 的 status=$3，只留 f」在 R3 上存活，说明 f 单独就能挡住）。同一个 R3-M6 放到修前树上跑，F1/F2 失败（`mutation-check-base-M6.json`；F1/F2 在修前树上不加变异也失败，因为 f 会回退）。**过程说明**：第一轮 R3-M2（内存 store fencedWrite 不判租约）存活，原因是其他用例都跑在「PG 形状 store + MemorySql」上。补了 `r3-memory-fence` S3 之后重跑，被抓到（`mutation-check-M2-rerun.json`）。每次变异后 src/tests/integrations 全部文件逐个核对 sha256，已恢复
- 变异清单：沿用 R2/R2a 中代码还在的条目。R2-M4 按 R3 的 fenceClause 改写了替换串；R2-M10 因为 D85 改口径，换成 R3-M11（「回退成只提醒员工档」，被抓到）

## §5 盲测复算（留出测试集；修前留出测试集产物）

130 条语料（评估 113 条无上下文）和留出集 47 条，rules 与 rules+stub 两种模式的结果相同：

| 指标 | 130 修前（R2a 树） | 130 R3 | 留出集修前 | 留出集 R3 |
|---|---|---|---|---|
| ① 严格（格式明确的报单，整句动作都办完） | 29/30（相关评测条目后半句被丢） | **30/30** | 32/32 | 32/32 |
| ① 只出清单 | 30/30 | 30/30 | 32/32 | 32/32 |
| ② 该澄清却直接办 | 0/18 | **0/18** | 0/12 | 0/12 |
| 该拒绝：严格拒绝率 | 5/9 | **9/9** | 3/3 | 3/3 |
| 该拒绝：没有误执行 | 9/9 | 9/9 | 3/3 | 3/3 |
| ③ 其余过问率（桩，不考核） | 46/56 | 43/56（相关评测条目客套话改为短答） | — | — |

和修前相比，回复有变化的只有相关评测条目，留出集零变化。**注意**：留出集里没有越权查询类，也没有复合句类说法，所以 D95/D96 没有独立的盲测证据；只有用不同说法写的单测/e2e（§2）。

## §6 未决（不在本轮范围，或者待拍板）

1. A-P1-3：真实模型、真实 OpenDot 验收（不在范围内）
2. v8 是否部署过（不在范围内）
3. D84：金额上限，以及「超过 5 万多确认一次」，待 hanyu 拍板（未实现）
4. D81：是否开放补报，待 hanyu 拍板
5. D98：同步死循环的隔离方式（worker 线程还是子进程），等真实 OpenDot 验收时再定
6. 积压告警接收人（D40）仍未决

## §7 冻结 R3 时新出现的待定项

1. **非今天的清单不再收**（D81 落地后的直接后果）：原来「历史日期请发带日期标题的清单」的补录路径关了。如果门店依赖这条路补录，现在只能找店长；店长侧的补录入口还不存在。
2. **D95/D96 缺独立盲测**：建议再出一份含「越权查询 / 跨店 / 复合句」的新留出集来验证泛化。
3. **D85 新增的收件人**：店长、老板现在也会收到自己单据的 30 分钟提醒。如果老板不报单，就没有影响；如果有影响，需要确认通知量。
4. **客套话口径**：只覆盖纯致谢、寒暄、道别（去掉语气词和表情后什么都不剩的那种）。吐槽、情绪类（如「累鼠了」）仍然走通用澄清，要不要短答待定。
5. 复合句只认「查本人进度/已入账」作为可以顺带执行的后半句，其他第二件事一律明说没办，不顺带执行。要不要放开更多组合待定。

## §8 约束

没有 commit、没有 push，没连服务器，没碰企微和共用 PG，没读 env 和凭据，没用 sudo。repo-r2a、其他 worktree、私有审查目录都只读（开工和收尾的写入检查见 `writer-check-*.txt`）。临时 PG 已停。删除说明：只在本轮自己的临时目录 `R3/tmp` 下删过几个自己生成的子目录，没有删除任何数据。私有审查目录期间有另一个 agent 在写（复审记录和 HANYU-DECISIONS 等），所以 audit 目录的总 hash 会变，这和本轮无关；私有评测产物本轮没碰过。
