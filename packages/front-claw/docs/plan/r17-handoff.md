# R17 移交项（交助手B修复）

来源：[history/R17/REPORT.md](history/R17/REPORT.md)「未完成 / 移交 Codex」一节。原文里引用的评测原句在公开版中已删掉，下面只描述现象。

| # | 问题 | 建议修法 | 相关文件 |
|---|---|---|---|
| 1 | **锁定集掉 1 条（48/56 < 49/56）**：行首有「报单」的错字标签加冒号时，客户被解析成「标签:客户」，单闸判为不纯，改成通用先问 | 在 `stripLinePrefix` 一带把「报单/报数」及常见错字形态的「X：」标签剥掉后再取客户；**不放宽单闸** | `src/role-eval/standard-line.ts`、`confirmable-draft-gate.ts`；补自编正反例到 `tests/r17/r17-single-gate.test.ts` |
| 2 | **句首吐槽＋报单不再出草稿**（「累死了，张姐680（小王）」变成先问；`tests/r3a/r3a-vent.test.ts` 已暂时改成期望先问） | 解析层在逗号处切开，句首整段是吐槽或客套时剥掉，再取客户；修好后恢复 r3a 原期望 | `standard-line.ts`、`remark-courtesy.ts`、`tests/r3a/r3a-vent.test.ts` |
| 3 | **单闸还不是唯一拦截点**：入口和循环里仍有 D146/D147 和括号非名字的提前拦截 | 改成「只决定追问措辞，不决定能不能出草稿」，或在 D81 之前调用单闸的 `impureReason`；补变异：删掉入口拦截后门② 仍为 0 | `employee-entry.ts`、`employee-loop.ts`、`confirmable-draft-gate.ts` |
| 4 | **自然句抽取的条目仍可过闸**（非严格标准行的多笔自然句照样出草稿） | 先由产品确认自然句是否归模型路径：归则对 `natural` 来源不传 entries，并把相应锁定条目标 `pending_formal_test`；不归则写进 D152 例外 | `employee-loop.ts`、`confirmable-draft-gate.ts` |
| 5 | **`BRACKET_NOT_NAME` 是新加的小词表**（只用于括号） | 产品确认能否使用、是否挪进 `config/` 并冻结 | `confirmable-draft-gate.ts` |
| 6 | **复合口径范围**：目前只有进度、查询和认不出的后半句整句先问；改账、预约、目标、宣传仍是「草稿＋后半句没办」 | 如果产品要求所有复合句都先问，要同时调整锁定集标注和 r4/r10/r11 的相应测试 | `employee-loop.ts`（`shouldHandCompoundToModel`、`compoundKeepsDraft`） |

修完后的复审流程：冻结树 → 公布树哈希和补丁 sha256 → 助手B先用旧的留出测试集原样复测，再用新的留出测试集判准入；更早的一组带勘误作回归。test:pg 至少跑 5 次，单独报入账笔数和金额。
