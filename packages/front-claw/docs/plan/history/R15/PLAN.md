# R15 计划

## 口径

- D145：结构识别复合本人进度，剥出后走 D141（草稿＋只读查询），不当备注；按 D144 不算快通道。
- D146：D142 固定说法仍剥后放行；未见过的否定补报先问，可带「是不是要报这位客户」；不出可确认草稿；不进客户名/备注。
- D147：无法识别碎片先问，不进客户名/备注，不出可确认草稿。客户栏含补报/否定残片则不认。

## 改动点

- 新模块 `self-progress-shape.ts`：结构判断；`standard-line` 的 residual/peel、`clauseKind`、员工环后半句用它（与原 selfProgressPhrase 并）。
- 新模块 `negated-makeup.ts`：固定说法表（保持 R14 剥离）、结构检测、hint 抽取、具体追问句。
- `employee-loop`：未见过否定补报在出草稿前追问；后半句用结构判断触发 myProgress。
- `isOpenedSelfCustomerName` / `isAcceptableCustomerLabel`：残片污染不认。
- 测试 `tests/r15/`：三类各训练+自留；纯标准行回归；不改 D143。
- 变异：R14 全套 + 每类至少一条新的。不写 HANYU-DECISIONS（除非必要；若写只从 D145 追加，先核 sha）。
