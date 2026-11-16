# 凭据与配置名字清单

凭据只放服务器 env 文件（权限 600，仓库外），不放进 Git、镜像、参数、状态或日志。本表只列变量名和用途，不含值；连接串特殊字符须 URL 编码。

必须拆成两份不同的文件：CORE_ENV_FILE 仅含应用连接、企微、模型与核心功能配置；ADMIN_ENV_FILE 含 PG 管理口令、管理连接串、账号口令及试点非密配置。核心只加载前者，admin 与 Compose 插值使用后者；管理文件绝不注入核心。两个文件中的机器人标识必须一致，管理文件不放机器人或模型密钥。不要把管理变量复制到核心文件。

| 变量名 | 用途 |
| --- | --- |
| `PG_ADMIN_PASSWORD` | 管理文件：Compose 新建 PG 管理账号口令，已有卷须按数据库原流程同步轮换 |
| `DATABASE_ADMIN_URL` | 管理文件：迁移、账号授权、试点初始化与消费者租约核查连接串 |
| `APP_DB_PASSWORD` | 管理文件：幂等创建或更新应用账号口令 |
| `READONLY_DB_PASSWORD` | 管理文件：幂等创建或更新只读账号口令 |
| `APP_DATABASE_URL` | 仅离线驱动临时生成的应用连接串；生产核心使用 FRONT_CLAW_DATABASE_URL |
| `READONLY_DATABASE_URL` | 独立只读权限验收连接串，生产核心不使用 |
| `FRONT_CLAW_DATABASE_URL` | 核心文件：最小权限应用连接串，内部 PG 主机名为 pg，账号为 front_app |
| `FRONT_DOT_CHANNEL` | Compose 固定选择生产企微或独立离线通道 |
| `FRONT_CLAW_WECOM_BOT_ID` | 核心与管理文件：机器人标识，管理命令只用作绑定标识 |
| `FRONT_CLAW_WECOM_BOT_SECRET` | 仅核心文件：生产长连接凭据 |
| `FC_MODEL_MODE` | 核心文件：默认安全桩，真实模式须单独授权 |
| `FC_MODEL_TIMEOUT_MS` | 核心文件：模型调用及响应消费的超时预算，与请求剩余截止取较小值 |
| `FC_MODEL_BASE_URL` | 核心文件：兼容模型服务的基础地址，含版本路径；运行时追加 chat/completions |
| `FC_MODEL_API_KEY` | 仅核心文件：兼容模型的 API 密钥，仅真实模式读取 |
| `FC_MODEL_NAME` | 核心文件：兼容模型名称 |
| `FC_MODEL_ENDPOINT` | 核心文件：未选择兼容基础地址时沿用原分类 HTTP 接口 |
| `FC_MODEL_CONFIG` | 核心文件：原模型 JSON 配置文件路径，可设置 apiKeyEnv 与 model；容器路径需经授权只读挂载 |
| `FRONT_CLAW_OPENDOT_CAPABILITIES` | 核心文件：可选平台能力收窄列表，不能授予原身份额外权限 |
| `FRONT_CLAW_MEM0` | 核心文件：沿用关闭约束，试图开启会拒绝启动 |
| `FRONT_DOT_PORT` | 核心文件：可选容器内健康端口，修改时须同步健康检查；生产始终绑定回环 |
| `PILOT_MEMBER_ID` | 管理文件：显式初始化的试点员工成员标识 |
| `PILOT_CORP_ID` | 管理文件：试点绑定的企业标识，须与入站事件一致 |
| `PILOT_DISPLAY_NAME` | 管理文件：试点人员显示名称 |
| `PILOT_STORE_ID` | 管理文件：试点所在门店标识 |
| `PILOT_STORE_NAME` | 管理文件：试点所在门店名称 |
| `PILOT_ROLE` | 管理文件：试点角色，employee、manager 或 owner |
| `CORE_ENV_FILE` | 操作 shell 提供的仓库外核心 env 文件绝对路径 |
| `ADMIN_ENV_FILE` | 操作 shell 提供的仓库外管理 env 文件绝对路径，同时供 Compose 插值使用 |
| `DEPLOY_DIR` | 操作 shell 指定的状态目录，默认通用部署目录 |
| `FRONT_DOT_SHA` | 镜像完整 SHA，部署脚本从 Git 取得并覆盖旧值；直接运行 admin 时须显式提供 |
| `SSH_ALLOW_CIDRS` | 操作 shell 提供的 SSH 网段列表，云规则生成与主机规则使用同一列表 |
| `BACKUP_DIR` | 操作 shell 指定的仓库外备份目录 |
| `BACKUP_RETENTION_DAYS` | 备份保留天数，缺省十四天 |
| `BACKUP_FILE` | 恢复归档路径 |
| `RESTORE_DB` | 新建恢复库名字 |

兼容接口仅在真实模式且提供 FC_MODEL_BASE_URL 时选择，同时要求 FC_MODEL_API_KEY 与 FC_MODEL_NAME；配置缺失或非法时安全拒绝启动。模型只返回分类 JSON，不接收工具、存储对象或确认能力。严格 schema、金额守卫、统一确认闸和挂起位沿用既有链路，超时、响应消费超时、限流或错误一律追问。此功能只用注入 fetch 的本地假服务测试，未连接真实模型。未选择兼容接口时沿用配置里的 apiKeyEnv，仅真实模式读取其指定变量。默认安全桩不读兼容接口凭据；离线 e2e 不读取任何企微、模型配置文件或密钥。

CORE_ENV_FILE、ADMIN_ENV_FILE、DEPLOY_DIR、SSH_ALLOW_CIDRS 与备份控制变量由运维操作 shell 显式提供；脚本不 source 服务器 env 文件，不要假定文件里的 shell 控制变量会自动导出。Compose 只静默展开服务需要的变量。不要把文件或展开配置复制进仓库；备份也须保存在受保护的外部目录。所有部署脚本要求宿主 Node 22+，缺失或版本过低会在执行动作前明确退出 2。
