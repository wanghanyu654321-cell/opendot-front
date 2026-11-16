# R9 PLAN

1. 配置 `config/remark-whitelist.json` 按类别列出白名单；`src/role-eval/remark-whitelist.ts` 读取配置做「整条备注由白名单词拼成」判断，并导出门店项目名接口（默认证配置，可合并外部表）。`classifyStandardRemark` 只在整条命中时 `allow`；约数仍 `hedge`；其余 `model`。员工入口对 `model` 备注不进可确认草稿，交给模型，桩则追问。
2. `src/role-eval/customer-conflict.ts`：归一 + 去称谓；核心名 ≥2 字对整行做包含匹配；核心名仅 1 字则整词相等，完整带称谓的全名（≥2 字，如「王姐」）仍可在行中整段出现时命中（「王丽」不含「王姐」）。`employee-loop` 在原精确匹配之外走这条兜底，命中则二选一。
3. D129：无钟点、无项目、无「预约」动词的「今天+称呼+来店」陈述，回固定问句，不起预约草稿。
4. D132：`tests/r7/gate-eval.ts` 的种子改为标准行，摘要输出 `seed_fail`。
5. 自编单测 `tests/r9/`（含「不错但没做」、前缀+李小雪、丽/王姐 vs 美丽/王丽）。跑门①锁定集，误伤记入 REPORT。tsc / 单元 / 变异 / test:pg（pg-temp 55432，用完停）。写 REPORT、补丁、SHA256SUMS。不 commit。
