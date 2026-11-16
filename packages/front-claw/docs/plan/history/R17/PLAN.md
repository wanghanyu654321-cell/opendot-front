# R17 计划

1. 查清 R16-07：010 UNIQUE + ON CONFLICT 是否挡住第二笔；双「已入账」是否只是回复问题。按结论修：commitConfirmingDraft 仅在本次关闭草稿时返回 >0，否则 0；入口只在 >0 时回「已入账」。加暂停点并发测试与 PG 测试。
2. 单闸 mayCreateConfirmableReportDraft：所有 createDraft(report) 必须过闸（标记便于变异）。standard-line 收紧括号与客户位。模型桩不能开闸。
3. R16-05：非名字走通用追问，不定「是新客户吗」。
4. 自编四类各 ≥15 条先问。锁定标注。变异：绕过单闸、不在名单也写进客户、确认非幂等。
