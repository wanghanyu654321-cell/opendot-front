# R16 计划

- 删除 `self-progress-shape.ts` 及其词表；standard-line / clauseKind / employee-loop 不再用结构判断。R14 对 D141 原短语的 peel 可留在解析层，但入口在出草稿前把「报单＋本人进度」整句交给模型路径，离线先问。
- 新模块 `model-path-ask.ts`（D148）：`rosterNameInUtterance` 只在已确认名单里找出现在原句中的名字；金额只取 `guardUtteranceAmounts` 已确定结果。两者都有才用具体追问。去掉 `hintReportSlots` 在生产路径的使用。
- `config/negated-makeup-fixed.json`：收纳现行 D142 固定剥离（含 R15 两条），strip 从配置组装，行为与 R15 对齐，不再加说法。
- 更新 r15/r14/r11/r3 复合入口测试为先问无草稿；第 2 档具体追问须先种已确认客户。
- 变异：R15-M1 随结构判断删除而移除；新增 R16-M1（名单改文本猜）、R16-M2（复合进度仍出草稿）。
