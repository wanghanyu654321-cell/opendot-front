# R7 PLAN

1. 开工：detached worktree `repo-r7`，基线 G 上加载 R6 树 `0904915a`。`repo-r4` / `repo-r5` / `repo-r6` 冻结。unset GIT_INDEX_FILE。
2. 先查清 R6-01 金额绕过白名单的路径（探针，不改 R6），把根因写进 REPORT，再落统一校验，不往 MODIFIER_CHARS 加词。
3. 金额（D120）：新增 `amount-guard.ts` 作为唯一收口。`guardUtteranceAmounts` 检查整句里每个金额表达式（后缀未知汉字失败关闭、前缀识别亏/赔/不到等方向与约数，不改符号）；`guardAmountTerm` 校验单项；`sealDraftAmounts` 在草稿写入前复核，源句不安全或分值对不上则抛 `unvalidated_amount`。标准行（「客户：金额（员工）」）纯数字按元收；自由句无单位小数追问；`0.33w`/`3k`/`1.2万` 直接解析。所有产出金额的路径（report-parse、report-extract、ledger-commands、模型槽位、改金额）都走此函数。
4. 跨员工隐私（D118）：二选一草稿按查看者裁剪。普通员工对别人的单只存/只回「已有一笔别人报的单」，选项「新增一笔 / 找店长改」；自己的单可「改第 N 笔」，可见数据不含 `reporterPersonId`。店长看全貌并可改 N。找店长改只提示、零写入。
5. 分类接口（D119）：新增严格 schema 与默认关闭的桩（不调真模型）。规则不新增对象×动作同义词表。模型输出经同一校验链；拿不准追问；只读查询且有权限则直接办、不确认。测试用桩验证接口和链路，报告不自报门③。
6. 选择短语（D121）：放宽 `parseAddNewChoice` / `parseCorrectionPick`，新增 `parseAskManagerChoice`。自编用例，不取留出集原句。
7. 验证：tsc / build、单元全量（只允许 2 条 live-model-smoke 失败）、test:pg（仅 pg-temp 127.0.0.1:55432，用完停）、变异至少 5 个且全杀、留出测试集仅记录（已污染）。出补丁、树 hash、REPORT（D 从 D118 起）。收尾写入检查，确认 R4/R5/R6 树未改。
