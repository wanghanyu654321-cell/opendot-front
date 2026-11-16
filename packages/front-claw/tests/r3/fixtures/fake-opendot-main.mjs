// R3：子进程里的“OpenDot main”替身：调用真实钩子（TS 源，Node 类型剥离），然后完成自己的启动并发心跳。
// 输出：OPENDOT_STARTED（宿主启动完成）、TICK（事件循环仍在转）、WARN <alert>（钩子告警）、STATE <state>。
const [hookPath, modulePath, budget] = process.argv.slice(2);
const { startFrontClawHook } = await import(hookPath);
const out = line => process.stdout.write(line + '\n');
const logger = { info() {}, warn(fields, message) { out(`WARN ${fields?.alert ?? ''} ${fields?.stage ?? ''} ${message ?? ''}`); } };
const handle = await startFrontClawHook(logger, { FRONT_CLAW_OPENDOT_ADAPTER: '1', FRONT_CLAW_OPENDOT_START_TIMEOUT_MS: budget, FRONT_CLAW_OPENDOT_MODULE: modulePath });
out('OPENDOT_STARTED');
let ticks = 0;
setInterval(() => { ticks += 1; out(`TICK ${ticks} ${handle.state()}`); }, 25);
handle.ready().then(() => out(`STATE ${handle.state()}`));
