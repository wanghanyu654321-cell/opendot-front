# R11 计划

1. 工作区已用 `git read-tree -u --reset` 载入 R10 树，HEAD 停在 G。不覆盖决策文件。
2. D135：改 `config/remark-courtesy.json` 为产品定稿词表；`stripTrailingCourtesy` 改为「只有整段都是客套才剥」，混合句原样交给 D130。去掉「待确认」。改 R10 里按「从末尾剥」写的断言。
3. R10-01：删掉 `remarkForDraftPolicy` 里「`clauseKind(s) && k !== 'report'` 则返回空」的短路。`interpretStandardTail` 只剥确定匹配的归属/复合/客套（归属按边界，避免从「不算我的」里掏「算我的」）。残余无论 `clauseKind` 是什么都走 `classifyStandardRemark` / D130。写自编用例（含「谢谢，不过没做」「帮写个朋友圈」这类会被分句判成店务的备注）。变异：残余白名单检查放行后，该测试必须失败。
4. D137 / R10-02/04：在同一份语法里，金额后、无括号时识别「算/记/报/登我的（名下）」和「报 X 的 / 记 X 名下 / 帮 X 报 / 替 X 记」。我 → 报单人；X 记到 `employeeName` 并核对本店；与括号冲突则追问。20+ 自编变体。
5. R10-05：`CONNECTOR` 补「顺带」，句读后若后半句确定是另一件店务则拆开。已认出完整报单时，不单独走改账把报单丢掉；改账由 leftover 明说没办。多行里的改账分句不当成整单失败。报单+改账写自编用例。相关评测条目已在锁定 ID 里，独立再跑锁定。
6. R10-06：推广 `maskNegatedPastDay`；`AMOUNT`、`parsePureMoney`、amount-guard 的单位都认 元整/块整/整。各 10+ 变体，语法一处改、测试覆盖多种写法。
7. R10-07：`customerOf` 拒绝动词/时间词（过来、到店、开始、来做、明天…）当名字；点不出名字则 `customerNamed=false`，入口追问。
8. D136：`remainingRemarkAfterPeel`（归属+复合+整段客套之后的备注）作为分母条件；空则不计。分子看最终 `outcome === 'clarify'` 且剩余备注非白名单（不靠固定句式）。摘要写门槛 ≤5%、是否超过、类别分布或片段。
9. 测试放 `tests/r11/`，自编句子（钱姐、周老师、李小雪、孙姨），不抄复审记录、不打开留出集。更新 R10 与新口径冲突的断言。
10. 跑 tsc、build、单元、变异、锁定、test:pg、留出测试集记录；写 REPORT、补丁、SHA256SUMS；临时索引核对 R4–R10 树未被改动。
