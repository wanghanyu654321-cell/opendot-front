# OpenDot × Front Claw 单容器部署与真机联调指南

## 1. 架构收敛与隔离边界

- **单核心容器（`core`，`replicas: 1`）**：在同一个 `node:22.14.0-bookworm-slim` 进程树内运行 OpenDot 控制面、原生企微长连接（`imManager.connectUserWeCom`）、Front Claw 前置拦截器（`createWeComFrontClawBridge`）、PG 17 单消费者租约（`ConsumerLease`）以及受控同进程 Agent 沙箱（禁用 `Bash` / `Write` / `Edit` / `NotebookEdit`，剥离 `FRONT_CLAW_*` / `PG*` / `DATABASE_URL` 环境变量）。
- **独立 PG 17（`pg`，`postgres:17.6-bookworm`）**：挂于内部 `private` 网络；`core` 仅使用最小权限 `front_app` 账号连接（`FRONT_CLAW_DATABASE_URL`），管理口令与迁移命令仅由按需 `--profile tools` 的 `admin` 容器执行。
- **零旁路补丁**：旧的 `opendot-hook.patch` 已彻底移除。

## 2. 首次启动步骤（单容器真机联调）

1. 在仓库外准备两份 `chmod 600` 配置文件：
   ```bash
   cp deploy/.env.core.example /srv/opendot/core.env
   cp deploy/.env.admin.example /srv/opendot/admin.env
   chmod 600 /srv/opendot/core.env /srv/opendot/admin.env
   # 编辑填入真实 PG 口令、FRONT_CLAW_WECOM_BOT_ID / BOT_SECRET 与 PILOT_* 试点人员信息
   ```

2. 导出外部路径并拉起 PostgreSQL 17：
   ```bash
   export CORE_ENV_FILE=/srv/opendot/core.env
   export ADMIN_ENV_FILE=/srv/opendot/admin.env
   set -a; . "$ADMIN_ENV_FILE"; set +a
   docker compose -f deploy/docker-compose.yml build
   docker compose -f deploy/docker-compose.yml up -d pg
   ```

3. 执行 PG 17 迁移、`front_app` / `front_readonly` 最小权限授权，以及首个试点人员初始化：
   ```bash
   docker compose -f deploy/docker-compose.yml --profile tools run --rm admin migrate
   docker compose -f deploy/docker-compose.yml --profile tools run --rm admin seed-pilot
   ```

4. 启动单副本 `core` 并验证健康检查与 ConsumerLease：
   ```bash
   docker compose -f deploy/docker-compose.yml up -d core
   curl -fsS http://127.0.0.1:${WEB_PORT:-3000}/api/health
   ```

5. 初始化 OpenDot 管理员账号（用于 Web 控制台与非店务营销 `pass` 回复路由）：
   - 访问 Web 界面完成首次注册，或执行：
     ```bash
     docker compose -f deploy/docker-compose.yml exec core node dist/reset-admin.js admin <强密码>
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
