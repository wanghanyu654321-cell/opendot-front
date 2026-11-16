/** M07 OpenDot 薄适配公开出口（OpenDot 钩子只调用 startFrontClawOpenDotService）。 */
export { startFrontClawOpenDotService, operationIdFor, isFrontClawOperation, parsePlatformCapabilities } from './adapter.js';
export type { FrontClawOpenDotService, OperationReport, AdapterState, AdapterDeps } from './adapter.js';
export { createWecomLongConnectionChannel, wecomChannelFromEnv } from './wecom-channel.js';
export type { FrontClawChannel, InboundText } from './wecom-channel.js';
export { createConsumerLease, CONSUMER_LEASE_KEY } from './consumer-lease.js';
export { MEM0_ENABLED_FOR_FRONT_CLAW, assertMem0Off } from './mem0-off.js';
export * from './host-contract.js';
