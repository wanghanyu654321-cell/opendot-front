# 运行记录格式

审查方在沙箱外的一次性本地 PG17 环境中，先按 [先决条件](../README.md) 配好 PG_BIN 并构建，再执行以下命令生成规范记录：

```sh
node scripts/e2e/run.mjs --backend local --out .e2e-records/local
```

记录由驱动生成，不能手写通过结果。默认输出为仓库根 `.e2e-records/<日期时间>/`，已被 `.gitignore` 忽略；可显式指定仓库外目录。样例记录不放仓库，禁止把运行输出写入文档目录。固定输出目录中的同名文件会覆盖。集成测试使用系统临时目录，成功或失败均清理，不在这里留下记录。默认不传 --out 时，驱动仍按运行时间新建目录。

`steps.json` 顶层字段为 version、notice、backend、steps；每个 step 含 step、command（固定脱敏模板）、exitCode、durationMs、counts，失败时含稳定错误码和可选断言名。`summary.json` 含 version、notice、backend、status、gates、steps、failures。每份文件均标明 notice="合成数据，不代表线上"。

| 步骤 | 含义 |
| --- | --- |
| prepare | 创建一次性 PG17 或离线 Compose 项目 |
| initialize | 运行现有迁移、创建最小权限账号、写入合成身份 |
| permissions | 验证只读写入及应用账号结构变更均被拒绝 |
| start-core | 启动独立核心并等待健康 |
| model-flow | 假模型合法草稿与五类追问，经统一确认闸和同一挂起位，账本不变 |
| flow | 合成报单、草稿、回“对”入账、查进度及重复消息去重 |
| restart-core | 停旧进程后启动新核心 |
| replay | 验证重启后相同消息不重复入账、不重复回复 |
| quiesce | 停核心，停止写入后再取快照 |
| backup | 逐表行数与哈希快照、PG 自定义格式备份 |
| restore | 恢复到新库并比较全部表行数及哈希 |
| start-restored-core | 应用账号连接恢复库，启动新进程 |
| restored-progress | 经相同入口查询恢复库，核对进度一致 |
| gates | 门①②：未复跑（需授权语料） |
| cleanup | 停核心、清理一次性 PG 或本次 Compose 容器及卷 |

正常完成输出 `e2e_passed` 和 `未复跑（需授权语料）`，摘要为 status=passed、steps=15、failures=0；整体 passed 仅指合成步骤，门①②并未通过。失败时非零退出，只记录实际执行的步骤。

写盘前校验固定命令模板、选定字段和合成声明；拒绝绝对路径、用户名、主机名、地址和连接串，违规内容不回显。备份本体与查询正文只存临时目录并随环境清理。命令只显示仓库相对路径或 `<tmp>`、`<project>` 等占位，不暴露运行环境信息。

门①②需要授权语料，由有权限的人依 [门禁复跑](../README.md#门禁复跑) 在同一环境另跑，驱动固定记录“未复跑（需授权语料）”。Compose 后端需要 Docker，本环境只有静态校验结论；有 Docker 的机器上实跑的确切参数与预期输出见 [Compose 路径](../README.md#compose-路径)。
