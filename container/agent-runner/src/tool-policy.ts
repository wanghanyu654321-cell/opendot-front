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
  agent: 'Task',
  task: 'Task',
  get_subagent_result: 'TaskOutput',
  taskoutput: 'TaskOutput',
  steer_subagent: 'TaskStop',
  taskstop: 'TaskStop',
  notebookedit: 'NotebookEdit',
};

export function resolveDisallowedToolSet(
  input: Pick<ContainerInput, 'agentProfile'>,
  env: NodeJS.ProcessEnv = process.env,
): {
  rawList: string[];
  canonicalLower: Set<string>;
} {
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
  if (canonicalLower.has(lower)) return true;
  const mapped = TOOL_NAME_CANONICAL_ALIASES[lower];
  return mapped ? canonicalLower.has(mapped.toLowerCase()) : false;
}
