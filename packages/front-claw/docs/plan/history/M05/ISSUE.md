# M05：预约登记即成立，提醒指定店长

日期：2026-11-11（UTC+8）。状态：实施前立项（写于代码改动前）。结果以 REPORT.md 为准。
分工：助手A侧编写；助手B负责方向、把控与审查；架构负责人不再审查。
依据：MERGED.md M05 节、§5.2 旧 21 项 #8/#14、§7 决定项 #3；WORKFLOW-SUMMARY §2.1/§6.3；dev-summary A4 遗留两问题。

## 1. 背景与用户目标

诉求 ①⑤⑥。员工登记预约后看到真实登记结果，预约一经确认即成立；店长只收到提醒，不需要回复，也不承担强制回传。

可复现的现状缺口（M04 树 1aca630d）：
- 员工窄入口（employeeLoop）没有预约能力：「预约 张三 15:00」「明天三点有个客人要来」路由为 appointment（或澄清），到 loop 后回“请发标准清单”。
- 旧入口预约状态机为 pending_manager → 店长「确认预约 N」→ confirmed → 通知员工。这是旧验收 #8/#14 的错误语义，即强制店长确认。
- 旧入口通知是同步发送：`notify()` 先插 pending 再调 send，状态回写失败时返回 unknown；`pushManagers` 发给本店全部店长和老板，而不是指定店长；通知和预约不在同一事务里。
- A4 遗留两个问题：①“用序号重试确认会确认到下一笔”；②“通知失败会被吞掉”。
- 自然语言时间（明天/后天/周五/三点/下午三点半）没有解析器；旧解析只认「预约 名字 HH:MM」。

## 2. 基线与现有实现

| 已确认 | 推断/未验证 | 本 Issue 新增 |
|---|---|---|
| 基线 = f2a8105 + m04-cumulative.patch；工作树 repo-m05，树 1aca630d | 店长手机可见、SDK 1.0.7 主动推送对真实账号可用（未验，交 M06/M09） | 员工入口预约草稿：回显日期/星期/时间/顾客/项目/门店/提醒对象，「对」后成立 |
| `appointments.ts`（parse/validate/stage）、`appointmentLineId`、`commitConfirmingAppointments`、`performance_appointments`/`performance_notifications` 表已存在；status/kind 均为 text 列 | 线上是否已有 pending_manager 历史（迁移交 M08） | 预约与待发提醒同一事务（策略 FOR SHARE → 草稿 confirming→confirmed → 预约 INSERT → 提醒 INSERT） |
| SDK `@wecom/aibot-node-sdk` 1.0.7：`sendMessage(chatid, {msgtype:'markdown', markdown:{content}})`；本仓 `wecom-bot-sender.notify(member, content)` 已封装 | — | 提醒只落 pending 行并生成发送载荷；不调用 send（派发在 M06） |

## 3. 范围

- [ ] 能力新增 `appointment_submit`（登记）、`appointment_receive`（作为提醒对象、查本店预约）。
- [ ] 指定店长：PG config `front-claw-appointment-recipients`（每店 1 人）。收件人须为该店在职完整人员，且当前策略授予 `appointment_receive`；无合格收件人时预约仍成立，回复“提醒待配置”。
- [ ] 解析：沿用 `parseAppointmentUtterance`（「预约 名字 HH:MM」）；新增自然语言解析（日期词 + 时间词 + 来店词），有空格和无空格的写法得到同一结果；缺时间就问，过去时间拒绝，不猜。
- [ ] 草稿 → 回显 →「对」成立 /「取消」不写；草稿 ID 由会话 + 消息号决定；预约号按内容确定（门店 + 登记人 + 时间 + 顾客 + 备注），重复消息不增；并发确认只有一份预约、一条提醒。
- [ ] 每一步都走 M03 鉴权：入口、建草稿前、确认前、提交事务内（策略行 FOR SHARE）；收件人资格在同一事务内按锁住的策略重判。收件人被撤权只丢提醒，不回滚预约。
- [ ] 店长不回复，预约照样有效：跨闭店、跨营业日仍有效；employeeLoop 模式下「确认预约 N」只解释新规则，不写。
- [ ] 遗留①：同一消息号的「对」重放只返回原结果，不会确认后来的草稿；旧入口序号确认的防错有测试锁定。
- [ ] 遗留②：提醒行写入失败时整笔回滚，回“结果未知”，不谎称已登记；提醒状态为 pending/not_sent/unknown 时，「预约结果」如实显示“未送达/未知”，不写“已通知”。
- [ ] 路由：「明天三点有个客人要来」等进 appointment。语料方面，调参集追加，新增 M05 盲测集（先冻结 hash 再改分类器）；店务→营销保持 0。

## 4. 明确不做

不真实发送（M06）；不做重试、租约、恢复（M06）；不强制店长确认或回传；不做排班、资源校验、支付、客户门户；不加临近提醒；不迁移历史 pending_manager（M08）；不改 schema；不写真实配置；不 commit/push/PR；不连服务器或企微；不读 env/凭据；不用 sudo/docker。

## 5. 依赖与兼容

依赖 M02/M03（以及 M04 的草稿框架）。旧入口（非 employeeLoop）的 pending_manager 流程保持原样，但旧入口不能处理员工入口的预约草稿；员工入口的新预约 status=`registered`，旧「预约列表」不会把它当待确认。

## 6. 验收与故障

有空格和无空格的写法得到同一预约；确认后预约 1 条、待发提醒 1 条；重复消息不增；店长不回复、跨闭店仍有效。以下情况都不回滚预约，也不谎称已送达：无收件人、收件人被撤权、明确发送失败（模拟 M06 回写 not_sent）、回执未知。PG17（非线上版本）验证：并发确认、撤权×确认竞态、收件人撤权×确认竞态、锁序、重启续跑。

## 7. 开关与回滚

不授予 `appointment_submit` 即关闭登记；不授予 `appointment_receive` 或不配置收件人，即只登记不排提醒；历史保留。回滚 = 不应用 m05.patch。

## 8. 完成说明

见 REPORT.md。
