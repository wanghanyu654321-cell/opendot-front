# M07 报告：OpenDot 薄适配（2026-11-11 北京时间 UTC+8）

工作树 <本地路径>，基于 M06 树 5839f303，独立索引；未提交/推送/PR）。
m07 树 d95be9f0b7af312409b6d778d37305af87246570。

## 0 默认值（D42–D50，均可改）
D42 适配器默认关（FRONT_CLAW_OPENDOT_ADAPTER=1 才开）；D43 平台能力未设=不收窄、设了只能收窄、未知名拒绝启动；D44 租约 30s/续约 10s/standby 重试 10s；
D45 关停等在途 10s 后中止；D46 企微凭据走 env（假设 A2）；D47 适配器失败不阻塞 OpenDot 启动；D48 操作 ID = front-claw:+sha256(bot,corp,member,msgid)前 40 位；
D49 取消不撤账，只报真实状态；D50 丢租约只停入站与派发，重叠窗口靠 M01–M06 确定性 ID 幂等。

## 1 改动
- 新增 src/opendot/：adapter（入口 startFrontClawOpenDotService）、wecom-channel（复用 createBotSdkAdapter/createBotSender/normalizeBotFrame）、consumer-lease（performance_config 一行，不改表）、mem0-off、host-contract（OpenDot 出处与假设 A1–A3）。
- OpenDot 侧只有补丁文件 integrations/opendot-front-claw/opendot-hook.patch：新增 src/front-claw-hook.ts（只 import node 内置）+ index.ts 三处。**未应用到任何 OpenDot 目录**，只在临时副本验证。
- 复用小改：store 加 insertConfigIfAbsent（INSERT … ON CONFLICT DO NOTHING，补上首写无行锁的竞态）；boot 加 platformCapabilities/open/stopNotificationDispatch；导出 UNBOUND、wecomSdkLogger。
- 绑定校验从严：bot+企业+成员+启用+绑定账号=人员账号；帧缺企业号也按未绑定处理（与 controlled-real pilot 一致）。
- 删除：appointments.ts 的 buildReminderPayload/ReminderPayload（唯一引用是 appointment-m05 测试，已改为断言正文长度）。保留 integrations/native/**、native-bot-*、wecom-bot-pilot.ts（回滚件，仍有测试引用）。
- 参考：kubernetes/client-go tools/leaderelection（租期>续约>重试×1.2，无 fencing）；microsoft/botbuilder-js BotAdapter/CloudAdapterBase.processActivity；pact-foundation/pact-js（消费者契约+假提供方）。

## 2 数字
tsc 0；M01–M06 定向 15/18/21/25/20/20；M07 27/27；回归 200/200；全量 925 中 923（2 失败为已知 live-model-smoke）；typecheck/build 0；
test:pg（PG17 临时，**非线上版本**）44/44，M07 PG 5 项重复 5 次全过；默认 PG16 路径未变（44 跳过）；变异 19/19 抓到、还原 sha 一致。
M07 关键用例：默认关零副作用；撤权后「对」被拒零写入；平台层能收窄不能放宽；静态扫描无直写/无 OpenDot·Mem0·调度器 import；
真实 PG：6 池并发首抢租约 10 轮各 1 个赢、持有者崩溃到期接管且重投同 msgid 不重复、时钟偏差双消费 5 轮各 1 笔、撤权持锁时确认在 FOR SHARE 等待后被拒。

## 3 未验证（对真实 OpenDot）
真实 OpenDot 进程/类型检查/测试/容器（本机无其依赖，OpenDot 只有 zip、无 git SHA）；真实企微长连接；线上 PG 版本；pino logger 只按子集（info/warn(fields,msg)）假设；
补丁按 zip 版本行号生成，OpenDot 上游变动后需重做；未做子进程 kill -9 崩溃（以“不关停不释放”模拟）。

## 4 已知限制
- 无 fencing：租约重叠窗口里两个实例可能都回复同一条消息（入账只一笔，测试覆盖）。
- 并发首次迁移同一新库会撞 23505（既有 migratePerformance 无 advisory lock，非 M07 引入；线上库已建表）。M03 updateAccessPolicy(expectedVersion=null) 首写有同类竞态。
- 生产通道用 SDK 适配 'isolated-synthetic' 模式（没有多成员 real 模式）；SDK 自动重连关闭，由适配器 30s 后重建通道。
- 模型端口仍是固定闲聊桩（同 pilot），未复用 OpenDot 模型配置；OpenDot 侧没有 Native 身份。
- 箱子重启恢复：node_modules 重新在线安装（lock 未变，sha 77909f18…3530）；pg-temp/data 权限与 13 个空目录被恢复丢失，已补回（未删数据）。其它工作树的 node_modules 也丢了，未动。
- M08 备忘（用户决定）：通知状态继续用状态文本编码；正式列与 due 索引放进 M08 迁移，本次未改 schema。

## 5 需决定
1 企微凭据来源：env（现做法）还是复用 OpenDot channel_accounts（需要 OpenDot 暴露读取接口，侵入更大）。
2 是否接受 OpenDot index.ts 三处改动 + 新文件这一最小补丁（OpenDot 没有插件扩展点）。
3 模型：沿用固定桩，还是接 OpenDot 模型配置。
4 迁移加 advisory lock（不改表）是否放进 M08。
5 平台能力 FRONT_CLAW_OPENDOT_CAPABILITIES 首批是否设置（例如 B 店试点先只开 report_self/report_proxy/progress_self）。
