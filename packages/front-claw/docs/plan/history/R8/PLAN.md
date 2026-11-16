# R8 PLAN

1. 新建 `src/role-eval/standard-line.ts`：一份标准行语法（D125），含标题、一行明细、多行、前缀、称谓、中文万/千、全半角、行尾备注分类（D123）、无单位小数政策（D122）、非今天日期（D124）。`parseEntryLine` / `parseLooseReport` / `parseReportText` / `extractReport`（先走语法）/ `isStandardAmountLine` / `guardUtteranceAmounts`（标准行上下文）都调用这里，不再各层切分。金额后缀不得跨行。
2. `guardUtteranceAmounts` 的 span 扫描：换行是硬边界；`guardAmountTerm` 在标准行上下文套用 D122。
3. 加强 `maskNegatedPastDay` / `pastDayReportPhrase`，并在入账前按语法再判 D124。
4. `parseAddNewChoice` 放宽从句（D126）。`looksLikeAppointment` / `parseAppointmentRequest` 收窄到标准预约格式（D127）。`DEFAULT_MODEL_TIMEOUT_MS = 8000`（D127）。评测脚本分快通道/模型 p95（D128）。
5. 自编单测 `tests/r8/` + 门①锁定 ID 集（只读已公开的留出测试集语料，按 ID 取此前通过的标准行）。变异 ≥5。全量 tsc/build/单元/test:pg（pg-temp 55432，用完停）、留出测试集只记录。
6. 写 REPORT、r8.patch、r8-cumulative.patch、SHA256SUMS。不 commit。
