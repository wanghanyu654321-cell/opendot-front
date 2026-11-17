# OpenDot × Front Claw 单容器部署与真机联调指南

## 1. 架构收敛与隔离边界

- **单核心容器（`core`，`replicas: 1`）**：在同一个 `node:22.14.0-bookworm-slim` 进程树内运行 OpenDot 控制面、原生企微长连接（`imManager.connectUserWeCom`）、Front Claw 前置拦截器（`createWeComFrontClawBridge`）、PG 17 单消费者租约（`ConsumerLease`）以及受控同进程 Agent 沙箱（禁用 `Bash` / `Write` / `Edit` / `NotebookEdit`，剥离 `FRONT_CLAW_*` / `PG*` / `DATABASE_URL` 环境变量）。
- **独立 PG 17（`pg`，`postgres:17.6-bookworm`）**：挂于内部 `private` 网络；`core`（`NODE_ENV=production`）严禁传入裸 `FRONT_CLAW_DATABASE_URL`，必须通过宿主机外部只读凭据文件（`FRONT_CLAW_DB_URL_FILE` → `/run/secrets/front_claw_db_url:ro`，权限不宽于 `0600`、属主 UID 匹配容器 `id -u node` 即 `1000`）以最小权限 `front_app` 账号连接（`FRONT_CLAW_DATABASE_URL_FILE`），管理口令与迁移命令仅由按需 `--profile tools` 的 `admin` 容器执行。
- **零旁路补丁与员工工作区隔离**：旧的 `opendot-hook.patch` 已彻底移除；非店务营销 `pass` 路由会为每位通过前置绑定的员工自动派生独立受控工作区 `web:wecom-front-claw:<sha256前16位>`，避免跨员工 Sticky Session 串线。

## 2. 首次启动步骤（单容器真机联调）

1. 在仓库外准备配置文件与只读 PG 凭据文件（`APP_DB_PASSWORD` / `READONLY_DB_PASSWORD` 均须至少 24 位）：
   ```bash
   cp deploy/.env.core.example /srv/opendot/core.env
   cp deploy/.env.admin.example /srv/opendot/admin.env
   printf 'postgres://front_app:%s@pg:5432/front_dot' '<url-encoded-24+-char-app-password>' > /srv/opendot/front_claw_db_url
   chmod 600 /srv/opendot/core.env /srv/opendot/admin.env /srv/opendot/front_claw_db_url
   # 凭据文件属主必须匹配容器内 node 用户 UID（node:22.14.0-bookworm-slim 为 1000，可用 docker compose run --rm --no-deps --entrypoint id core -u node 核对）
   chown 1000:1000 /srv/opendot/front_claw_db_url
   # 编辑 core.env / admin.env 填入真实 PG 口令、FRONT_CLAW_WECOM_BOT_ID / BOT_SECRET 与 PILOT_* 试点人员信息
   ```

2. 导出外部路径并拉起 PostgreSQL 17：
   ```bash
   export CORE_ENV_FILE=/srv/opendot/core.env
   export ADMIN_ENV_FILE=/srv/opendot/admin.env
   export FRONT_CLAW_DB_URL_FILE=/srv/opendot/front_claw_db_url
   set -a; . "$ADMIN_ENV_FILE"; set +a
   docker compose -f deploy/docker-compose.yml build
   docker compose -f deploy/docker-compose.yml up -d pg
   ```

3. 执行 PG 17 迁移、`front_app` / `front_readonly` 最小权限授权，以及首个试点人员初始化：
   ```bash
   docker compose -f deploy/docker-compose.yml --profile tools run --rm admin migrate
   docker compose -f deploy/docker-compose.yml --profile tools run --rm admin seed-pilot
   ```

4. **在启动 `core` 之前**初始化 OpenDot 管理员账号（原生企微桥接器要求库内已存在真实活跃用户，未初始化时冷启动会拒绝建立企微连接并报错提示）：
   ```bash
   docker compose -f deploy/docker-compose.yml run --rm --no-deps core node dist/reset-admin.js admin <强密码>
   ```

5. 启动单副本 `core` 并验证健康检查、PG 租约与 `ConsumerLease`：
   ```bash
   docker compose -f deploy/docker-compose.yml up -d core
   curl -fsS http://127.0.0.1:${WEB_PORT:-3000}/api/health
   ```

6. 开启真实主动通知外发（确认前期被动回复联调无误后）：
   - 将 `core.env` 中 `FRONT_CLAW_NOTIFY_DISPATCH=1` 后重启：
     ```bash
     docker compose -f deploy/docker-compose.yml up -d --force-recreate core
     ```

## 3. 优雅停机与单消费者校验

- 停机时 `stop_grace_period: 30s` 触发 OpenDot Phase 1：先关闭 M06 派发器、等待在途店务 `employeeQueues` 落账并释放 PG `ConsumerLease`，再关闭 Agent 队列与企微 WebSocket。
- 升级或切换副本前可校验租约已释放：
  ```bash
  docker compose -f deploy/docker-compose.yml stop core
  docker compose -f deploy/docker-compose.yml --profile tools run --rm admin verify-consumer
  ```
