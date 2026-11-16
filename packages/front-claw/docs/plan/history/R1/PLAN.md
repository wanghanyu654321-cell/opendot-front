# R1 PLAN

## 设计（按对齐群补充要求）
1. **出口 (a) 入账门**：`src/role-eval/commit-gate.ts` 一个纯函数 `evaluateGate(spec, snapshot)`，快照 = 策略原文 + 高水位 + 提交人/被代报人当前人员行 + （可选）消费租约行。检查：策略版本 ≥ 高水位（缺失/坏高水位拒绝）、提交人当前在职且身份/门店/角色未变、按当前人员判能力、被代报人当前在职且与草稿同店、fencing 未过期且版本一致。
   - 提交事务内：PG 对上述配置行与人员行 `FOR SHARE`（人员变更 UPSERT 取行锁，与提交互斥定序）；内存 store 同步读取。
   - 事务外同一函数（读当前数据）：旧草稿重放、请求缓存命中、营销发出前、查询发送前。
2. **单调版本**：`updateAccessPolicy` 已拒绝 ≤ 当前；新增：通用 `setConfig` 拒写策略/高水位/审计键；读侧版本 < 高水位即拒绝。
3. **出口 (b) 发送门**：`beginNotificationSend` 事务内 FOR SHARE 读收件人当前行和关联草稿/预约，`decide` 用当前数据重判（停用/调店/换绑/草稿已确认→ not_sent）。
4. **共用 fencing**：`src/role-eval/fencing.ts`：单调递增 epoch + 到期时间。M07 租约每次换主 epoch+1，业务提交（经入账门）与回复前校验；M06 每次领取 epoch+1（状态里 `f=`，008 派生 `delivery_fence` 列），写结果时校验 epoch 与租约未过期。
5. **M06 编码**：严格 codec（规范重编码必须逐字相等、日历合法、计数 0..10000、键不重复、claimed/sending 必须有 tok/f）；畸形行不领取、不发送；008 触发器同规则 RAISE 拒绝，down 脚本删除新增列。补发改为单事务「CAS + 审计 insert-if-absent」。门店时区配置键 `front-claw-store-hours`，默认 Asia/Shanghai / 23:00。
6. **M07**：租约 epoch；fence 贯穿 handler→入账门；回复前校验；hook 加启动截止（默认 15s）与迟到资源回收；操作号索引持久到 config（`front-claw-op:<id>`）；activate 失败统一逆序清理。
7. **M02**：解析前 NFKC；金额 k/千/w/万/元/块 换算整数；括号=代报员工；回显「1.2k → 1200」；路由用解析器而非关键词；规则非单一命中时调用兜底分类接口（输出 act/clarify/marketing/chitchat + 字段），默认确定性桩（恒 clarify），OpenDot 模型配置适配点可注入，不调用真实模型。

## 步骤
1. 写复现测试 tests/r1/*.test.ts，在未改代码上跑并留档（修前失败）。
2. 逐条实现；跑复现测试（修后通过）。
3. 调整受影响的既有测试（只改断言语义变化处，并在 REPORT 说明）。
4. 全量验证 + PG17 + 并发重复 + 变异检查。
5. 出 r1.patch / 累积补丁 / 树 hash / SHA256SUMS / changed-files / REPORT。
