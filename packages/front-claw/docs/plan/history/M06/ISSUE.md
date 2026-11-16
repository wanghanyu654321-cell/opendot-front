# M06 议题：持久通知、草稿提醒与故障恢复（2026-11-11 20:05 UTC+8 起）

来源：MERGED.md §5「M06｜持久通知、草稿提醒与故障恢复」；PR-13/14/15/16/17，DV-07/21/22/29；诉求①②⑤⑥；合审-05（unknown）、合审-07（持久领取，不用 Map）。

## 背景 / 现状（实测）
- M04 改账通知、M05 店长提醒只写 `performance_notifications` pending 行（确定性 ID），没有任何派发者。
- 员工入口（employeeLoop）下 `runMaintenance` 是空函数：员工入口的报数草稿没有提醒，也不会在闭店后作废。
- 旧入口的 `settleOpenNotifications` 在每次维护时把**所有** pending 行改成 unknown（会误伤 M04/M05 的待发行）。
- 发送通道：`wecom-bot-sender.notify(member, content, scope, beforeSend)` 已有：有界超时（≤4s）、`beforeSend` 预检、结果 accepted / rejected / blocked / unknown。
- 表结构：`performance_notifications(notification_id PK, kind, recipient_person_id, body, status text, related_id, created_at, sent_at)`；没有次数、下次时间、租约列。

## 范围
- 持久出站箱 + 派发器：领取用 `FOR UPDATE SKIP LOCKED` + 租约 + 领取令牌；过期领取者不能提交（条件更新）。
- 状态：pending（含 排队/已领取/发送中）、sent（企微已接受）、not_sent（明确失败）、unknown（结果未知）。
- 明确失败有限退避；unknown 不当 sent，也不自动重发：告警 + 可审计的人工补发（有上限）。
- 崩溃/重启恢复：领取后、发送前崩溃 → 租约到期后重领；已进入发送阶段后崩溃 → 判 unknown，不重发。
- 发送前在同一事务里（策略行 FOR SHARE）重判收件人资格与关联对象（预约仍有效、草稿仍待确认等）。
- 「我的预约」如实显示派发状态。
- 员工入口报数草稿：待确认满 30 分钟提醒一次；闭店过期作废并通知一次；已确认的不提醒；预约不因闭店作废。
- 生产接线：注入发送接口，复用现有长连接 `notify`；真实发送受开关控制，默认关闭；可在 PG 配置里暂停领取。
- 补发策略：按默认，不给“配置店长之前登记的预约”补提醒；提供一个默认关闭的开关。

## 非目标
- 不承诺企微端到端恰好一次；不引入 Redis/新队列/pg-boss；不催店长回复；不真实发送。

## 约束
- 不改 schema（除非不可避免→停下列为决定）。不 commit/push/PR；不连服务器、不碰真实企微/env/凭据、不 sudo/docker。PG17 临时集群不是线上版本。

## 验收
- [ ] 两个以上派发者竞争：每条只发一次（假发送器计数）。
- [ ] 领取后/发送中/发送后写状态前崩溃 → 重启后恢复正确（重领或 unknown），不重复发送；用真实子进程 + 隔离 PG17 kill -9。
- [ ] 发送中撤权：撤权先提交 → 不发；撤权方持锁 → 派发等锁后不发。
- [ ] 发送器超时 → unknown，不自动重发；人工补发留审计、有上限。
- [ ] 明确失败有限退避，次数到上限 → not_sent。
- [ ] 过期领取者的结果被丢弃，不覆盖。
- [ ] 「我的预约」状态与表一致。
- [ ] 报数草稿提醒一次、已确认不提醒、闭店作废一次；预约不受影响。
- [ ] 开关默认关；暂停配置生效且保留数据。
- [ ] 单元、M01–M06 定向、全量、test:pg、变异、typecheck、build。
