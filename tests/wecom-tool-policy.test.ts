import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DefaultResourceLoader,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test } from 'vitest';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';
import {
  DEFAULT_ALLOWED_TOOLS,
  isToolDisallowed,
  resolveDisallowedToolSet,
  resolveEffectivePiToolPolicy,
} from '../container/agent-runner/src/tool-policy.js';
import { getBundledFrontClawSkillsRoot } from '../src/wecom-front-claw-skills.js';

const WECOM_CONTROLLED_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
  'TaskOutput',
  'TaskStop',
  'WebFetch',
  'WebSearch',
  'mcp__miniclaw__*',
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('WeCom controlled agent-runner tool policy', () => {
  test('supports safe trailing-prefix wildcards without matching unrelated namespaces or unsafe patterns', () => {
    const policy = resolveDisallowedToolSet(
      {
        agentProfile: {
          id: 'wecom-safe',
          name: 'WeCom Safe',
          version: 1,
          isDefault: false,
          identityHash: 'h',
          identityPrompt: 'safe',
          includeClaudePreset: false,
          disallowedTools: ['mcp__miniclaw__*'],
        },
      },
      {},
    );

    expect(
      isToolDisallowed('mcp__miniclaw__send_message', policy.canonicalLower),
    ).toBe(true);
    expect(
      isToolDisallowed('mcp__miniclaw__schedule_task', policy.canonicalLower),
    ).toBe(true);
    expect(
      isToolDisallowed(
        'MCP__MINICLAW__WORKSPACE_MEMORY_GET',
        policy.canonicalLower,
      ),
    ).toBe(true);
    expect(isToolDisallowed('mcp__miniclaw__*', policy.canonicalLower)).toBe(
      true,
    );

    expect(
      isToolDisallowed('mcp__miniclaw_other__foo', policy.canonicalLower),
    ).toBe(false);
    expect(
      isToolDisallowed('mcp__external__send_message', policy.canonicalLower),
    ).toBe(false);
    expect(isToolDisallowed('Read', policy.canonicalLower)).toBe(false);

    // Unsafe patterns (*, **, mid-string wildcard) must never grant blanket matching
    expect(isToolDisallowed('Read', new Set(['*']))).toBe(false);
    expect(isToolDisallowed('Read', new Set(['**']))).toBe(false);
    expect(isToolDisallowed('mcp__a__send', new Set(['mcp__*__send']))).toBe(
      false,
    );
    expect(isToolDisallowed('mcp__a__b', new Set(['mcp__*__*']))).toBe(false);
  });

  test('covers subagent, search/fetch, and filesystem aliases across profile and env', () => {
    const aliasPolicy = resolveDisallowedToolSet(
      {
        agentProfile: {
          id: 'alias-check',
          name: 'Alias Check',
          version: 1,
          isDefault: false,
          identityHash: 'h',
          identityPrompt: 'safe',
          includeClaudePreset: false,
          disallowedTools: [
            'agent',
            'get_subagent_result',
            'steer_subagent',
            'find',
          ],
        },
      },
      {
        MINICLAW_AGENT_DISALLOWED_TOOLS: JSON.stringify([
          'webfetch',
          'websearch',
          'bash',
        ]),
      },
    );

    expect(isToolDisallowed('Task', aliasPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('Agent', aliasPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('TaskOutput', aliasPolicy.canonicalLower)).toBe(
      true,
    );
    expect(
      isToolDisallowed('get_subagent_result', aliasPolicy.canonicalLower),
    ).toBe(true);
    expect(isToolDisallowed('TaskStop', aliasPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('steer_subagent', aliasPolicy.canonicalLower)).toBe(
      true,
    );
    expect(isToolDisallowed('Glob', aliasPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('find', aliasPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('WebFetch', aliasPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('WebSearch', aliasPolicy.canonicalLower)).toBe(
      true,
    );
    expect(isToolDisallowed('Bash', aliasPolicy.canonicalLower)).toBe(true);
    expect(aliasPolicy.rawList).toEqual(
      expect.arrayContaining([
        'Task',
        'TaskOutput',
        'TaskStop',
        'Glob',
        'WebFetch',
        'WebSearch',
        'Bash',
      ]),
    );

    // Comma-separated fallback env and direct canonical alias set
    const csvPolicy = resolveDisallowedToolSet(
      { agentProfile: undefined },
      { MINICLAW_AGENT_DISALLOWED_TOOLS: 'agent, steer_subagent' },
    );
    expect(isToolDisallowed('Task', csvPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('TaskStop', csvPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('Task', new Set(['agent']))).toBe(true);
  });

  test('strips all dangerous, subagent, network, and mcp__miniclaw__* tools under WeCom controlled denylist', () => {
    const customTools = adaptClaudeMcpToolsToPi(
      createMcpTools({
        chatJid: 'web:wecom-front-claw-test',
        groupFolder: 'wecom-front-claw-test',
        isHome: true,
        isAdminHome: true,
        agentBuilderEnabled: true,
        mem0CodingRecallEnabled: true,
        ownerProfileEnabled: true,
        isScheduledTask: false,
        currentTaskId: null,
        currentInputTurnId: 'turn-wecom-1',
        workspaceIpc: '/tmp/wecom-ipc',
        workspaceGroup: '/tmp/wecom-group',
      }),
      { namespace: 'mcp__miniclaw' },
    );
    expect(
      customTools.some((tool) => tool.name === 'mcp__miniclaw__send_message'),
    ).toBe(true);
    expect(
      customTools.some((tool) => tool.name === 'mcp__miniclaw__schedule_task'),
    ).toBe(true);

    const externalTools = adaptClaudeMcpToolsToPi([
      {
        name: 'Agent',
        description: 'external subagent',
        inputSchema: {},
        handler: async () => ({ content: [] }),
      },
      {
        name: 'WebFetch',
        description: 'external fetch',
        inputSchema: {},
        handler: async () => ({ content: [] }),
      },
      {
        name: 'bash',
        description: 'external bash',
        inputSchema: {},
        handler: async () => ({ content: [] }),
      },
    ]);

    const policy = resolveEffectivePiToolPolicy({
      input: {
        agentProfile: {
          id: 'wecom-safe-marketing',
          name: 'WeCom Safe Marketing',
          version: 1,
          isDefault: false,
          identityHash: 'safe',
          identityPrompt: 'marketing',
          includeClaudePreset: false,
          disallowedTools: [...WECOM_CONTROLLED_DISALLOWED_TOOLS],
        },
      },
      customTools,
      externalTools,
      env: {},
    });

    expect(policy.effectiveAllowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(policy.effectiveCustomTools).toEqual([]);
    expect(policy.backgroundTasksEnabled).toBe(false);
    expect(policy.excludedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'NotebookEdit',
        'Task',
        'TaskOutput',
        'TaskStop',
        'WebFetch',
        'WebSearch',
        'mcp__miniclaw__*',
        'mcp__miniclaw__send_message',
        'mcp__miniclaw__schedule_task',
      ]),
    );
    for (const allowed of policy.effectiveAllowedTools) {
      expect(DEFAULT_ALLOWED_TOOLS).toContain(allowed);
    }
  });

  test('pi-index.ts uses resolveEffectivePiToolPolicy consistently and keeps autoCompactEnabled: true untouched', () => {
    const piIndexSource = fs.readFileSync(
      path.resolve('container/agent-runner/src/pi-index.ts'),
      'utf8',
    );
    expect(piIndexSource).toContain('resolveEffectivePiToolPolicy');
    expect(piIndexSource).toContain(
      'backgroundTasksEnabled: toolPolicy.backgroundTasksEnabled',
    );
    expect(piIndexSource).toContain(
      'allowedTools: toolPolicy.effectiveAllowedTools',
    );
    expect(piIndexSource).toContain(
      'customTools: toolPolicy.effectiveCustomTools',
    );
    expect(piIndexSource).toContain('excludedTools: toolPolicy.excludedTools');
    expect(piIndexSource).toContain('autoCompactEnabled: true');
  });

  test('preserves Read capability required for Pi to load bundled SKILL.md via skillPaths', async () => {
    const tempWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wecom-pi-skill-loader-'),
    );
    tempDirs.push(tempWorkspace);
    const agentDir = path.join(tempWorkspace, '.pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });

    const policy = resolveEffectivePiToolPolicy({
      input: {
        agentProfile: {
          id: 'wecom-safe-marketing',
          name: 'WeCom Safe Marketing',
          version: 1,
          isDefault: false,
          identityHash: 'safe',
          identityPrompt: 'marketing',
          includeClaudePreset: false,
          disallowedTools: [...WECOM_CONTROLLED_DISALLOWED_TOOLS],
        },
      },
      customTools: [],
      env: {},
    });
    expect(policy.effectiveAllowedTools).toContain('Read');

    const settingsManager = SettingsManager.create(tempWorkspace, agentDir, {
      projectTrusted: true,
    });
    const loader = new DefaultResourceLoader({
      cwd: tempWorkspace,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: [getBundledFrontClawSkillsRoot()],
    });
    await loader.reload({ resolveProjectTrust: async () => true });

    const { skills, diagnostics } = loader.getSkills();
    const marketingSkill = skills.find(
      (skill) => skill.name === 'beauty-local-content',
    );
    expect(marketingSkill).toBeDefined();
    expect(marketingSkill?.filePath.endsWith('SKILL.md')).toBe(true);
    expect(
      diagnostics.filter((diag) => diag.path?.includes('beauty-local-content')),
    ).toEqual([]);
  });
});
