# R2a 报告：发送门 UPDATE 的 f 条件变异（R2-M2a）

- 起点：R2 树 `dfedabfa3c38f4048f6a5474c91be67f1570da86`（未动 repo-r2）；工作树 `<本地路径>`（HEAD = G `f2a8105a…` + read-tree dfedabfa）。
- **新树：`6fcd27659ce4d7c149a8a4887e72c7ebc284d9c0`**（`r2a-tree.txt`）。`r2a.patch`（相对 dfedabfa）和 `r2a-cumulative.patch`（相对 G）都已在干净目录里 `git apply`，复现出同一棵树。
- 改动：只新增了一个测试文件 `tests/r2a/r2a-send-fence.integration.test.ts`（111 行），**没有改任何源码**。

## 结论：真的等价，不是 bug。另外发现一个相邻的测试缺口，已经补上。

1. **去掉 f 条件是真等价变异。** 加上新用例，再跑全量 test:pg（75 条），这个变异仍然存活（X0、M2a）。原因不在于“有行锁”，而在于同一条 UPDATE 里的 `status=$3` 本身就已经蕴含了 `f=$4`：
   - f 是 status 原文里的一个字段（`notification-status.ts:35-37`，`|f=` 最多只出现一次；err 字段的字符集里没有 `|`）。`$4 = decodeStatus($3).fence`，而 SQL 端的 `FENCE_OF_STATUS`（`performance-postgres.ts:112`）对同一原文抽出来的值是一样的（`test-output/fence-sql-probe.txt` 在 PG17 上实测过，包括 `err=f=9` 这种干扰）。
   - 所以对任何一行，只要 `status=$3` 成立，`FENCE_OF_STATUS(status)=$4` 就必然成立。去掉 f 不会多放过任何一行。
   - 旧领取者被重新领取之后，status 原文里的 f/tok/by/due 都变了（f 单调递增），所以 `status=$3` 不可能成立。
2. **哪几道检查挡住了旧领取者**（变异组合实测见 `test-output/mutation-probe-r2a.txt`）。下面 ①②③ 三道，任意一道单独保留都能挡住“B 已重新领取”的情况（X5、X6、X7）：
   - ① `src/role-eval/performance-postgres.ts:606-608`：`SELECT … FOR UPDATE` 锁住通知行，再比对原文 `text(row.status) !== expectedRaw` → lost；
   - ② 同一文件 `:613-615`：条件 UPDATE 里的 `status=$3`，0 行 → lost；
   - ③ `src/role-eval/notification-dispatch.ts:206`：decide 里比对 `row.delivery.fence !== meta.fence`，同时判断租约是否到期（`dueAt <= now`）。
   - **同一事务、同一行锁**：①②③ 都在 `beginNotificationSend` 的同一个 `client.transaction(...)` 里（`performance-postgres.ts:586`）。这个事务的实现（`src/role-eval/performance-open.ts:71-88`）只持有一个连接：`pool.connect()` → `BEGIN` → work → `COMMIT`。③ 是在 609 行对 606 行锁住的那一行调用的，② 写的也是这一行，行锁一直持有到 COMMIT。
3. **相邻的测试缺口（这次新发现，已补用例）**：租约已过期、但还没人重新领取时，A 恢复。这时原文和 f 都没变，①②（以及 f 条件）都挡不住，**只有 ③ 里的租约到期判定挡得住**。R2 的测试没有覆盖这种情况：变异 X8 / R2a-M2c 只去掉租约判定，只有新用例 R2a-3 能杀掉它。所以 M06 那个 P1（租约过期后原领取者仍然能发送或标记）在发送门这一侧真正依赖的是这一道检查。它已经在同一个行锁之下，代码不用改，用例保留。

## 新用例（PG17，暂停点 `send-gate:before-begin`；A、B 各用独立连接池）
- R2a-1：A 领取（f=1）→ 暂停 → 租约过期 → B 领取（f=2）并发完 → A 恢复去发送和标记。
- R2a-2：A 在 B 领取之后、发送之前恢复，B 停在自己的发送门前。A 被挡，B 的 claimed 原文没被动过；随后放行 B，B 发完。
- R2a-3：租约过期、还没人重新领取时 A 恢复。A 被挡（原文不变），之后 B 领取并发完。
- 三条用例的断言都是：A 的发送记录（wire）为空；全部发送记录里只有 B 一条；`sent` 事件里只有 w-b；A 的统计是 `lost=1, sent=0`；终态是 B 的 `sent|…`，`a=1`；R2a-1 和 R2a-2 的审计行（`front-claw-notification:audit:*`）数为 0。

## 变异（`test-output/mutation-probe-r2a.txt`，每个变异都跑全量 test:pg）
| 变异 | 结果 |
|---|---|
| X0 只去 f | 存活（真等价） |
| X1 去 f + ① / X2 去 f + ② / X3 去 f + ③中 f | 存活 |
| X4 去 f + ③整行 | 被杀（R2a-3） |
| X5 只剩 ② / X6 只剩 ① | 被杀（只有 R2a-3）：说明 ① 或 ② 单独就能挡住重新领取 |
| X7 只剩 ③ | 存活：说明 ③ 单独也能挡住 |
| X8 只去 ③ 的租约到期判定 | 被杀（只有 R2a-3）：R2 的测试缺口 |
| X9 四道全去 | 被杀（p2b、R2a-1/2/3、M06 PG） |

R2 全套变异复跑（`mutation-check.py`，19 个）：18 个被杀，M2a 预期存活，19/19 符合预期。其中新增的 R2a-M2c 被杀，M3（结果写回去掉 f）仍然被杀。

## 验证（`test-output/`）
- tsc、typecheck、build：exit=0。
- 全量 vitest：1040 通过、2 跳过，失败的只有已知的 2 条 `live-model-smoke`。
- test:pg：75/75（R2 是 72，加上新增 3 条）；r2a + r2-pg + M06 PG 连跑 5 遍，每遍 18/18。
- 临时 PG17（`<本地路径>`）已停止，没有残留 postgres 进程。
- 写入检查：开始和结束各做一次（`writer-check-*.txt`），都没有别的写入进程；私有评测产物的哈希不变；repo-r2 的 index 修改时间不变，树仍然是 dfedabfa。

## 约束
没有 commit / push，没连服务器、企微和共用 PG（只连了 127.0.0.1:55432 的临时集群），没读 env 和凭据，没用 sudo，没删数据。
