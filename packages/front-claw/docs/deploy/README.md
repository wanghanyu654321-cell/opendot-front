# 部署脚本与验收边界

本交付只准备本仓库的 standalone 核心和部署脚本，没有连接或修改服务器。生产装配复用原企微长连接、Front Claw 分发、员工循环、实时授权与统一确认闸；完整 OpenDot 宿主仍需按原挂点补丁另行装配验收。本地合成通过不能代表真实员工闭环、手机实收或原 Agent 已恢复。不对外提供 HTTP/HTTPS 入口。

默认部署目录为 `/opt/front-dot`，由部署用户拥有（建议 ubuntu）；此为通用目录。服务器 env 文件在仓库外，权限 600。脚本不安装软件，不使用 sudo，不自动修改云安全组。修改数据的脚本默认 dry-run，只有显式 `--apply` 才执行。host.sh 在两种模式下都只检查已安装 Node、Docker 与 Compose 版本，不需要 root；firewall.sh 应用主机规则需要已授权的 root 运维会话。

## 部署步骤

1. 完成 [本地端到端](../e2e/README.md) 的合成验收，保留脚本生成的记录。门①、门②由有语料读取权限的人补跑，不以历史计数代替。
2. `bash scripts/deploy/host.sh` 检查宿主 Node 至少 22、Docker Engine 至少 29、Compose 至少 v5；版本不足、缺失或 Docker 不可访问时退出 2 并提示运维处理。不会安装、升级或启动 Docker 服务。
3. 按 [变量清单](credentials.md) 在服务器准备两份独立 env 文件。操作 shell 提供 CORE_ENV_FILE 与 ADMIN_ENV_FILE（绝对路径、分别权限 600、禁止指向同一文件）；DEPLOY_DIR 默认采用上述目录。生产数据库名为 front_dot，内部 PG 主机名为 pg；应用账号 front_app、只读账号 front_readonly，连接串须与口令变量对应。管理账号用于迁移，不给核心作业务连接。口令至少二十四字符，连接串特殊字符须 URL 编码。
4. 在 main 干净检出运行 `bash scripts/deploy/deploy.sh` 预览。默认拒绝非 main 和脏树；`--allow-dirty` / `--allow-non-main` 只用于有记录的例外。本地未提交验证不能作为 main 发布证明。应用和管理工具镜像均为 `front-dot:<完整 commit sha>`，不自动升级。
5. 获授权后执行 `bash scripts/deploy/deploy.sh --apply`：静态检查 → 准备/构建镜像 → 起 PG → 管理连接迁移到最新并建账号 → 停旧核心 → 确认无消费者 → 起新核心 → 健康检查 → 原子记录 current/previous SHA。迁移复用原迁移器的锁和校验和，当前实际为 007–011；不新增迁移，不虚构早期独立文件。账号创建/口令更新和授权在事务内执行，可重复；业务表读写授权仅给应用账号，只读账号仅 SELECT，迁移及导入历史应用账号也只读。不会写任何合成人员、绑定或业务数据。生产新库的试点账号由操作者按下节显式初始化；部署脚本不自动调用。已有账号、撤权或门店冲突会拒绝覆盖。
6. `deploy/compose.json` 的核心固定选择 wecom，通过 CORE_ENV_FILE 只读取应用连接、企微及模型配置；管理工具和 Compose 插值使用 ADMIN_ENV_FILE，模型默认安全桩；真实模型只能按原 FC_MODEL 配置另行授权。生产不设置合成准入变量，仅在容器回环地址提供健康检查；消息注入路由关闭。启动缺企微凭据时拒绝，日志不打印凭据值。已有 `isolated-synthetic` 检查原样保留，只在独立离线配置中使用。
7. 核心 active 后才保存状态（600）。失败先停故障核心并核对消费者，再尝试恢复原 current 镜像，不推进状态。首次部署没有原镜像时停故障服务后检查，不声称回退成功。缺状态或缺 previous 时，回滚明确报错并退出 2，不输出栈追踪。
8. 用 SSH_ALLOW_CIDRS 指定逗号/空白分隔的允许网段，预览 `bash scripts/deploy/firewall.sh`。人工在云控制台设置同一列表、仅允许入站 TCP 22，拒绝其他入站；脚本不访问云 API。主机应用规则先逐条放行再启用，详见 [网络](network.md)。

离线 Compose 使用独立 `deploy/compose.e2e.json`，不和生产文件合并，不引用服务器 env_file。离线驱动只读临时随机口令与指定的 PG 工具变量，不读企微或模型凭据。合成身份初始化只保留在该驱动的 initialize 步骤，生产部署无 initialize 选项。

```sh
node scripts/deploy/validate-compose.mjs
```

此命令静态检查生产和离线两份配置。有 Docker 的已授权环境中，部署脚本还执行 `docker compose --env-file "$ADMIN_ENV_FILE" -f deploy/compose.json config --quiet`；不保存展开配置，不将其贴进日志。

## 显式初始化试点账号

先完成迁移与账号授权。操作者在管理 env 文件配置 PILOT_MEMBER_ID、PILOT_CORP_ID、PILOT_DISPLAY_NAME、PILOT_STORE_ID、PILOT_STORE_NAME、PILOT_ROLE 和 FRONT_CLAW_WECOM_BOT_ID；机器人标识与核心文件一致，管理文件无需机器人密钥。角色只能为 employee、manager 或 owner，标识为最长 120 字符的字母、数字或 `_.@:-`，名称最长 80 字符，均不允许首尾空白或控制字符。缺项或非法值在打开数据库前失败。

```sh
docker compose --env-file "$ADMIN_ENV_FILE" -p front-dot -f deploy/compose.json run --rm admin seed-pilot
```

操作 shell 同时提供 CORE_ENV_FILE、ADMIN_ENV_FILE 和已审查的 FRONT_DOT_SHA。此命令独立于 deploy.sh；仅初始化人员、机器人与企业绑定、访问策略和 employee-loop 白名单，不连接企微或模型，不写账。使用与合成初始化相同的 savePerson / saveBinding / updateAccessPolicy / setConfig 路径，整次命令在同一 PG 事务执行。相同配置重复运行不增加人员、绑定、策略版本或审计行，白名单合并且不重复。默认仅授予本人报单与本人进度，owner 仅本人进度；已有策略层的收窄继续生效。当前白名单为单门店，其他门店或已撤销授权须由既有受控流程审查，命令拒绝覆盖。

审查方在一次性本地 PG 中运行：

```sh
AUDIT_PG_ALLOW=isolated-synthetic AUDIT_PG_URL='<LOCAL_DISPOSABLE_PG_URL>' npx vitest run --config vitest.integration.config.ts tests/deploy/pilot.integration.test.ts
```

测试只接受回环目标，在该一次性集群中新建独立随机库，跑两遍初始化后比较全部初始化行，再让同一请求实际经过 adapter 的绑定解析与员工循环，验证可产生待确认草稿、账本为空及企业不匹配被拒。结束删除测试新库，不使用应用数据库；本任务未运行该 PG 测试。

## 资源与备份

PG shared_buffers=128MB、work_mem=4MB、maintenance_work_mem=64MB、max_connections=30，容器内存上限 512MB；核心上限 384MB，连接池最多四条。构建峰值需要额外内存；部署前检查资源，必要时在 CI 准备同 SHA 镜像。脚本不自动配置交换空间、清盘或升级主机。

核心与管理容器的根文件系统只读，临时文件使用 /tmp 的 tmpfs。生命周期 active/closed/重连、告警与启动失败均为单行 JSON；失败仅输出安全类别、错误码和受控摘要，不打印原始异常、连接串或凭据。

常驻容器使用 json-file 日志，单文件 10MB、最多三份。监控磁盘与 PG WAL；wal_keep_size 不是 WAL 总量上限。运维先检查 `docker system df`，保留 current/previous 镜像，人工审查后才清理旧缓存。不可删除业务卷或对服务器项目使用卷清理。

```sh
bash scripts/deploy/backup.sh
bash scripts/deploy/restore.sh
```

默认只预览。备份时由操作 shell 指定仓库外 BACKUP_DIR、BACKUP_RETENTION_DAYS；显式应用后经 PG 容器的 PG17 pg_dump -Fc 归档，pg_restore --list 校验后原子改名。默认保留十四天，只清理目录内过期且匹配归档格式的普通文件。归档含业务事实，权限 600，需保护目录并定期异机保存。

恢复指定 BACKUP_FILE、RESTORE_DB（restore_ 前缀新名字）；只创建新库并恢复，不覆盖源库、不自动切连接。全局账号另行恢复并重审授权；停写后逐表比较行数/哈希，使用应用账号查进度，人工确认恢复时点之后的业务差异，再授权切换。服务器脚本只报告恢复完成，比较和切换须运维验收；合成驱动提供自动演练。

## 版本与合并准入

升级必须走 PR，CI 绿才能合。OpenDot 不自动升级；本适配器和完整宿主分别保留锁定版本。Node、PG 镜像固定补丁版本，应用与管理工具只用完整 Git SHA。镜像升级同样要经过 PR、相关测试和部署审查。

分支保护需仓库所有者手动操作：保护 main，要求 PR 审查及 check / pg 两项 CI 成功，禁止绕过审查直接推送。本任务只修改仓库 CI 文件，不改 GitHub 设置，也未验证已有保护状态。

部署与回滚均为 stop old → confirm no consumer → start new。确认包括本 Compose 项目内没有运行的核心容器、同 PG 消费租约 owner 为空或到期已超过十秒宽限；有效、宽限内或损坏的租约拒绝，稍后重试核查，不自动清租约。健康失败切回旧镜像也走相同步骤，不同时运行两个企微消费者。完整宿主或其他项目是否存在消费者仍须上线前独立核实。
