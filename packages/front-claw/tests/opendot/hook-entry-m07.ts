import { startFrontClawOpenDotService as start, type AdapterDeps } from '../../src/opendot/adapter.js';
import type { OpenDotHost } from '../../src/opendot/host-contract.js';

/** 钩子全链测试用入口：形状与 dist/opendot/index.js 相同，依赖（存储、离线通道、时钟）从全局注入。 */
export async function startFrontClawOpenDotService(host: OpenDotHost) {
  const deps = (globalThis as { __frontClawM07Deps?: AdapterDeps }).__frontClawM07Deps;
  if (!deps) throw Error('m07_test_deps_missing');
  return start(host, deps);
}
