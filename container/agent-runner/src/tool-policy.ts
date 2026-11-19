import type { ContainerInput } from './types.js';

export const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'mcp__miniclaw__*',
];

const TOOL_NAME_CANONICAL_ALIASES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  find: 'Glob',
  glob: 'Glob',
  grep: 'Grep',
  websearch: 'WebSearch',
  webfetch: 'WebFetch',
  agent: 'Task',
  task: 'Task',
  get_subagent_result: 'TaskOutput',
  taskoutput: 'TaskOutput',
  steer_subagent: 'TaskStop',
  taskstop: 'TaskStop',
  notebookedit: 'NotebookEdit',
};

function extractSafePrefixWildcard(pattern: string): string | null {
  if (!pattern.endsWith('*')) return null;
  const prefix = pattern.slice(0, -1);
  if (!prefix || prefix.includes('*')) return null;
  return prefix;
}

export interface DisallowedToolSet {
  rawList: string[];
  canonicalLower: Set<string>;
}

export interface EffectivePiToolPolicy<T extends { name: string }> {
  disallowedPolicy: DisallowedToolSet;
  effectiveAllowedTools: string[];
  effectiveCustomTools: T[];
  excludedTools: string[];
  backgroundTasksEnabled: boolean;
}

export function resolveDisallowedToolSet(
  input: Pick<ContainerInput, 'agentProfile'>,
  env: NodeJS.ProcessEnv = process.env,
): DisallowedToolSet {
  const fromProfile = Array.isArray(input.agentProfile?.disallowedTools)
    ? input.agentProfile.disallowedTools
    : [];
  const rawEnv = env.MINICLAW_AGENT_DISALLOWED_TOOLS?.trim();
  let fromEnv: string[] = [];
  if (rawEnv) {
    try {
      const parsed: unknown = JSON.parse(rawEnv);
      if (Array.isArray(parsed)) {
        fromEnv = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      fromEnv = rawEnv.split(',').map((item) => item.trim());
    }
  }
  const rawSet = new Set<string>();
  const canonicalLower = new Set<string>();
  for (const candidate of [...fromProfile, ...fromEnv]) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (!trimmed) continue;
    rawSet.add(trimmed);
    const lower = trimmed.toLowerCase();
    canonicalLower.add(lower);
    const mapped = TOOL_NAME_CANONICAL_ALIASES[lower];
    if (mapped) {
      rawSet.add(mapped);
      canonicalLower.add(mapped.toLowerCase());
    }
  }
  return { rawList: [...rawSet], canonicalLower };
}

export function isToolDisallowed(
  toolName: string,
  canonicalLower: Set<string>,
): boolean {
  const lower = toolName.trim().toLowerCase();
  if (!lower) return false;
  const canonical = TOOL_NAME_CANONICAL_ALIASES[lower]?.toLowerCase() ?? lower;
  if (canonicalLower.has(lower) || canonicalLower.has(canonical)) return true;

  for (const rawPattern of canonicalLower) {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === lower || pattern === canonical) return true;
    const mappedPattern = TOOL_NAME_CANONICAL_ALIASES[pattern]?.toLowerCase();
    if (
      mappedPattern &&
      (mappedPattern === lower || mappedPattern === canonical)
    ) {
      return true;
    }
    const prefix = extractSafePrefixWildcard(pattern);
    if (prefix && (lower.startsWith(prefix) || canonical.startsWith(prefix))) {
      return true;
    }
  }

  return false;
}

/**
 * Compute the effective Pi tool allowlist, custom tool list, and exclusion set
 * from one shared policy rule so allowedTools, customTools, excludedTools, and
 * system-prompt capability hints never diverge.
 */
export function resolveEffectivePiToolPolicy<
  T extends { name: string },
>(params: {
  input: Pick<ContainerInput, 'agentProfile'>;
  customTools: readonly T[];
  externalTools?: readonly T[];
  env?: NodeJS.ProcessEnv;
}): EffectivePiToolPolicy<T> {
  const disallowedPolicy = resolveDisallowedToolSet(params.input, params.env);
  const externalTools = params.externalTools ?? [];
  const allCustomTools = [...params.customTools, ...externalTools];

  const effectiveAllowedTools = [
    ...DEFAULT_ALLOWED_TOOLS,
    ...externalTools.map((tool) => tool.name),
  ].filter((name) => !isToolDisallowed(name, disallowedPolicy.canonicalLower));

  const effectiveCustomTools = allCustomTools.filter(
    (tool) => !isToolDisallowed(tool.name, disallowedPolicy.canonicalLower),
  );

  const blockedCustomToolNames = allCustomTools
    .filter((tool) =>
      isToolDisallowed(tool.name, disallowedPolicy.canonicalLower),
    )
    .map((tool) => tool.name);

  const excludedTools = [
    ...new Set([...disallowedPolicy.rawList, ...blockedCustomToolNames]),
  ];

  const backgroundTasksEnabled =
    effectiveAllowedTools.includes('Task') &&
    !isToolDisallowed('Task', disallowedPolicy.canonicalLower);

  return {
    disallowedPolicy,
    effectiveAllowedTools,
    effectiveCustomTools,
    excludedTools,
    backgroundTasksEnabled,
  };
}
