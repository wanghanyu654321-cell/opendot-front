# 公开版说明（脱敏）

本仓库是从私有工作区整理出来的公开版。导出时做了下面这些处理。

## 没有放进来的

- 任何 `.env`、凭据文件、密钥、日志、数据库数据、构建产物（`node_modules`、`dist`、`pg-temp`、`test-output`）。
- 评测留出集及其上下文、种子、映射、复审原文、续跑记录、独立评分，以及依赖它们的测试（见 [README.md](README.md) 第 3 节）。
- 内部复审汇总，改用 [../plan/status.md](../plan/status.md)（只写结论和数字）。
- 上游旧交接包 `docs/handoff-20261031/`（含现场日志和私有环境描述）。
- 第三方系统的参考材料。

## 换成占位符的

| 类别 | 公开版写法 |
|---|---|
| 服务器上的应用目录、数据目录、家目录、产物目录 | `<SERVER_APP_DIR>`、`<SERVER_DATA_DIR>`、`<SERVER_HOME>`、`<ARTIFACTS_DIR>` |
| 服务器私有凭据目录（代码里的默认路径） | `/srv/front-claw-private`（部署时按实际修改） |
| 共享 PG 容器名、Docker 网络名、旧库名 | `legacy-shared-pg`、`shared-business-net`、`shared-pg-net`、`legacy_appointment_db` |
| 旧隔离环境目录名 | `legacy-isolated-env` |
| 私有上游仓库所属组织、负责人邮箱、内部 wiki 链接 | `<PRIVATE_ORG>`、`<OWNER_EMAIL>`、`<INTERNAL_WIKI_URL>` |
| 测试账号主人的真实姓名 | 文档里写「测试员工A」，代码和测试里用虚构名「苏晓禾」 |
| 本地工作区路径 | `<WORKSPACE>`、`<LOCAL_HOME>` |

占位符替换后，守卫与测试的语义不变（例如守卫拒绝的共享库名和测试里的断言同步替换）。

## 文档里删掉的

历史议题和报告里引用的评测语料原句换成了「（评测原句已删）」，语料编号保留。

## 扫描

导出后用 gitleaks 和自定义正则做全量扫描：IP、手机号、企微 corp/bot ID、私钥、连接串密码、邮箱、上述真实值。结果为 0 命中才发布。
