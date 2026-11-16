// R3 合成模块：顶层同步死循环（模拟模块初始化同步卡死）。只在子进程里加载。
for (;;) { /* spin */ }
export async function startFrontClawOpenDotService() { return { close: async () => {} }; }
