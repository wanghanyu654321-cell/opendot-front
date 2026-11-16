# R13 计划（D139 修订 + D140，默认 C）

1. `config/customer-name-policy.json`：`mode` 默认 `"C"`，附《百家姓》单姓/复姓与 B 模式冲突表（周末…周五、全天）。A/B 可切换。
2. `customerNamePolicy`：对「不带括号且非姓＋称谓」在员工入口、完整解析之后判定（不缩小语法）。`storeCustomerRoster` 从本店已确认订单、预约、今天已报单草稿、以及回「是」后记住的名字收集；整词（去称谓后整词，核心名≥2 字）。
3. 「是」流程：操作记录挂起已解析清单；只回「是新客户「X」吗？」；「是」→ 记住名字 + 出草稿；其它（含「对」）→ 没有写入。
4. `resultText` 报单草稿每笔先单独一行「客户：X」。
5. 历史种子：`tests/r13/fixtures/historical-customers.json`，经 `insertEntries` 写入 2026-11-11 已确认行（等价于当日标准行报入并回「对」），评测 `runItem` 每种世界先种。
6. 自编测试 `tests/r13/`：非名字追问不执行；已种测试员工A/小雪/阿玲/李小雪/欧阳娜娜 直接出草稿且有「客户：X」；是→对入账并进名单；回别的不写；D131/D137；A/B/C 切换。更新 r12-self-name 种子与 r3a-header 精确格式。
7. 门①：`是新客户` 追问从分母排除、单独报数。评测分别跑 A/B/C。
8. 验收：tsc/build；完整单元（仅 2 个已知 live-model-smoke 失败）；test:pg 三次后停 pg-temp；完整突变（R11 7 + R12 3 + 新的展示与政策）；门①锁定独立再跑。不 commit、不写 HANYU-DECISIONS（D139 已在文件中）、不自报门③/④达标。
