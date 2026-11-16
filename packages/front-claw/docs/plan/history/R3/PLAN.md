# R3 PLAN

1. 准备：worktree，复制 audit 用例，开工写入检查。在 6fcd2765 原树上跑一遍 audit 用例，留作「修前」证据（含 PG stale-writes）。
2. A-P1-1：
   - PerformanceStore 新增唯一入口 `fencedWrite(fence, write)`，覆盖新建草稿、覆盖草稿、pending 草稿状态变更、操作记录 setConfig。
   - PG 实现：同一事务里先做条件锁读，租约行按 owner + epoch + until>now 匹配、FOR SHARE，0 行就返回 fenced；写 SQL 本身也带 `EXISTS(租约)` 条件。Memory 实现用同一判定。
   - employee-loop 和 adapter 的所有消费者写入都改走这个入口（commit* 原本就带 guard.fence）。
   - 静态检查测试：消费者模块里禁止直接调用 store 的写方法；performance-postgres.ts 里每条写 SQL 所在的方法必须登记在「fenced / 豁免（附理由）」清单里，出现未登记的就判失败。
   - REPORT 附全部写路径清单。
3. A-P1-2：hook 先返回，让 OpenDot 先启动完成；Front Claw 模块延后加载。import、模块初始化、start 都算进同一个超时预算，超时就标为 unavailable 并告警，迟到的结果关闭清理。用真实 hook + 合成卡住模块测异步卡住；同步死循环用子进程测试，证明会卡死、OpenDot 也一起失去响应，列为剩余 P2。opendot-hook.patch 有变化就重新出一份。
4. f：领取时在 SQL 里写 `f = f + 1`（应用层不再算 f）；重试、终态、unknown、requeue 都保留 f。发送门 UPDATE 的 f 条件保留并加注释。补两条测试：f 单调；去掉整段原文比对后只靠 f 也能挡住旧领取者。
5. 拒绝：泛化规则——查他人业绩、跨店点名、员工档要全店排名、跨店代报，直接回「不能」并说明原因。
6. 复合句：报单 + 查询时，查询按权限执行，报单仍只出待确认清单；做不了的部分要明说。
7. 产品三点、文档 D78/D83/D84、新增默认值从 D90 编号。
8. 验证：tsc、typecheck、build、全量测试、test:pg、竞态用例 5 轮、变异检查、盲测（130 条 + 留出集）。然后出补丁、树 hash、SHA256SUMS、REPORT，停 PG，收尾写入检查。
