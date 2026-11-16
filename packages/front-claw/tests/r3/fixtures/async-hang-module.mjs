// R3 合成模块：顶层 await 一个永不兑现的 Promise（模拟模块初始化异步卡住）。
await new Promise(() => {});
export async function startFrontClawOpenDotService() { return { close: async () => {} }; }
