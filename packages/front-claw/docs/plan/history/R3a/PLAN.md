# R3a PLAN

1. 开工写入检查；worktree 对上 9ecf7052。
2. 第 1 项：先在当前树上写测试跑一遍。若已通过，只补测试（含昨天/明天边界），不改入口逻辑。
3. 第 2 项：`isVent` 泛化规则（情绪词且无金额/店务动作/客人/预约时间）→ 闲聊短答；路由层先于其他判定。
4. 第 3 项：`legacyEntry` / `FRONT_CLAW_LEGACY_ENTRY`，默认关；关则构造抛 LegacyEntryDisabled；开则告警。OpenDot（employeeLoop）不进旧路径。更新 REGISTRY 注释。已有旧入口测试显式打开开关。
5. 第 4 项：不改代码。
6. 验证：tsc / typecheck / build、全量测试、test:pg、变异、盲测。出补丁、树 hash、REPORT（D 从 D99 起）。停 PG，收尾写入检查。
