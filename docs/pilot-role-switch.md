# 试点岗位切换

正式变更前，从已授权目录和当前策略确认目标人员、账号、所属门店及策略版本。使用已构建的软件包入口，以相同参数先预览，再提交。

```sh
node dist/standalone/pilot-switch.js preview PERSON_ID ACCOUNT_ID STORE_ID manager EXPECTED_VERSION
node dist/standalone/pilot-switch.js apply PERSON_ID ACCOUNT_ID STORE_ID manager EXPECTED_VERSION
```

核对返回的岗位、有效能力和新版本。版本冲突时重新读取并预览。共享权限不足时，命令拒绝变更；企业、门店和岗位上限由各自的策略管理者维护。若需恢复原岗位，以当前版本发起一次新的按人变更，审计记录保留。

仅在单人单店的隔离合成测试库中使用 `preview-synthetic-baseline` 或 `apply-synthetic-baseline` 替换首个参数。这两个操作使用 `AUDIT_PG_ALLOW=isolated-synthetic` 和 `AUDIT_PG_URL`，要求回环地址和 `synthetic_pilot_switch_` 前缀的库名。执行角色必须是该测试库的所有者；仅有表写权限不能执行重置。重置按目标岗位重建企业及门店上限、三档岗位基线和指定成员授权，预览显示预期有效能力。
