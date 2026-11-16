# 网络与单消费者

只允许入站 TCP 22，来源为 SSH_ALLOW_CIDRS 网段列表，逗号或空白分隔；其他入站一律拒绝。只保留出站，不对外提供 HTTP/HTTPS 入口。PG、核心、管理工具和离线驱动均不发布宿主端口。生产核心同时加入内部 private 与出站 outbound 网络，PG 仅在 private；离线配置仅使用 internal 网络。

默认示例为腾讯云网页终端代理公开网段：81.69.102.0/24、106.55.203.0/24、101.33.121.0/24、101.32.250.0/24、119.45.60.0/24。部署前由运维核对云平台当前来源；可用自己的固定来源列表替换。脚本不查询或修改云安全组，人工在云控制台逐条增加同一列表的 TCP 22 规则并删除其他入站放行。

脱敏示例：

```sh
SSH_ALLOW_CIDRS='<SSH_CIDR_A>,<SSH_CIDR_B>' bash scripts/deploy/firewall.sh
```

预览会生成以下计划：

```text
ufw default deny incoming
ufw default allow outgoing
ufw allow from <SSH_CIDR_A> to any port 22 proto tcp
ufw allow from <SSH_CIDR_B> to any port 22 proto tcp
ufw --force enable
```

必须是合法 IPv4/IPv6 CIDR，IPv4 前缀至少 /16，IPv6 前缀至少 /32；无前缀、空列表、超范围与所有零前缀表示均被拒绝。比各自门槛更宽的网段（包括两条 /1 拼出全网）一律拒绝。全列表先校验成功，再生成/应用规则；主机规则应用时先逐条允许 TCP 22，全部成功才启用 ufw。默认 dry-run；显式应用需要已授权 root 会话、已装 ufw 和无历史 allow/limit/route 例外。遇到旧规则交运维审查，不自动 reset。使用 IPv6 前须核对主机 ufw IPv6 配置。始终保留云控制台恢复通路和主机快照，避免配置错误锁死。

企微使用长连接，仅出站，固定一个核心消费者，原 PG 租约与 fencing 保持。入站消息都经 Front Claw 分发进入同一个员工循环；按确定性 msgid 身份在现有 PG performance_config 持久化去重，重启不重复业务处理或回复。结果未知时不盲目重试。不要并行启动相同身份的完整宿主或第二个项目；部署和回滚均先停旧、确认容器与 PG 消费租约已释放或已过期且超过十秒宽限，再起新。
