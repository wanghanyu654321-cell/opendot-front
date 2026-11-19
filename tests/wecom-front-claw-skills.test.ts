import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resolveEffectiveSkills } from '../src/effective-skill-resolver.js';
import { parseFrontmatter, scanSkillDirectory } from '../src/skill-utils.js';
import {
  DEFAULT_WECOM_MARKETING_SKILL_ID,
  ensureBundledWeComMarketingSkill,
  getBundledFrontClawSkillsRoot,
} from '../src/wecom-front-claw-skills.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-front-claw-skills-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('WeCom Front Claw bundled marketing skill', () => {
  test('bundles only beauty-local-content with clean safety guardrails and no legacy/secret leaks', () => {
    const bundledRoot = getBundledFrontClawSkillsRoot();
    expect(fs.existsSync(bundledRoot)).toBe(true);

    const skillEntries = fs
      .readdirSync(bundledRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(skillEntries).toEqual([DEFAULT_WECOM_MARKETING_SKILL_ID]);
    expect(DEFAULT_WECOM_MARKETING_SKILL_ID).toBe('beauty-local-content');

    const skillMdPath = path.join(
      bundledRoot,
      DEFAULT_WECOM_MARKETING_SKILL_ID,
      'SKILL.md',
    );
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const frontmatter = parseFrontmatter(content);

    expect(frontmatter.name).toBe('beauty-local-content');
    expect(frontmatter.description.length).toBeGreaterThan(20);
    expect(frontmatter['allowed-tools']).toBeUndefined();

    // Must explicitly declare marketing-only / no ledger or booking fabrication rules
    expect(content).toContain('严禁伪造');
    expect(content).toContain('入账');
    expect(content).toContain('预约');
    expect(content).toContain('写库');

    // Must not carry historical evaluation scaffolds, tenant names, or secrets
    for (const forbidden of [
      'Mem0',
      'PreparedBeautyCase',
      'read_eval_fixture',
      'SOURCES.md',
      'Frontagent',
      'R3/R4/R5/R6',
      'K01',
      'D01',
      'B01',
      'H01',
      '1.0.0-draft',
      'not-installed',
      'postgres://',
      'PGPASSWORD',
    ]) {
      expect(content).not.toContain(forbidden);
    }

    const scanned = scanSkillDirectory(bundledRoot, 'managed');
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({
      id: 'beauty-local-content',
      name: 'beauty-local-content',
      enabled: true,
      allowedTools: [],
    });
  });

  test('ensureBundledWeComMarketingSkill installs idempotently and passes resolveEffectiveSkills fail-closed', () => {
    const userSkillsDir = path.join(tempRoot, 'data', 'skills', 'owner-1');
    const hostSkillsDir = path.join(tempRoot, 'host-claude', 'skills');
    fs.mkdirSync(path.join(hostSkillsDir, 'host-only-skill'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(hostSkillsDir, 'host-only-skill', 'SKILL.md'),
      '---\nname: host-only-skill\ndescription: host skill\n---\n# Host\n',
    );
    fs.mkdirSync(path.join(userSkillsDir, 'unrelated-skill'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(userSkillsDir, 'unrelated-skill', 'SKILL.md'),
      '---\nname: unrelated-skill\ndescription: unrelated\n---\n# Unrelated\n',
    );

    const first = ensureBundledWeComMarketingSkill({ userSkillsDir });
    const second = ensureBundledWeComMarketingSkill({ userSkillsDir });

    expect(first).toEqual(second);
    expect(first.skillId).toBe('beauty-local-content');
    expect(first.skillDir).toBe(
      path.join(userSkillsDir, 'beauty-local-content'),
    );
    expect(first.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(first.skillDir, 'SKILL.md'))).toBe(true);

    const manifest = resolveEffectiveSkills({
      layers: [
        { source: 'host', root: hostSkillsDir },
        { source: 'managed', root: userSkillsDir },
      ],
      managedPolicy: { mode: 'custom', ids: ['beauty-local-content'] },
      hostPolicy: { mode: 'disabled', ids: [] },
    });

    expect(manifest.missingManagedSkillIds).toEqual([]);
    expect(manifest.missingHostSkillIds).toEqual([]);
    expect(manifest.selected).toHaveLength(1);
    expect(manifest.selected[0]).toMatchObject({
      id: 'beauty-local-content',
      source: 'managed',
      definitionHash: first.definitionHash,
    });
  });

  test('repairs tampered or disabled target skill directory idempotently', () => {
    const userSkillsDir = path.join(tempRoot, 'skills-repair');
    const initial = ensureBundledWeComMarketingSkill({ userSkillsDir });

    // Tamper with installed file and drop a disabled marker
    fs.writeFileSync(
      path.join(initial.skillDir, 'SKILL.md'),
      '---\nname: beauty-local-content\ndescription: tampered\n---\nTampered\n',
    );
    fs.writeFileSync(
      path.join(initial.skillDir, 'SKILL.md.disabled'),
      'disabled\n',
    );

    const repaired = ensureBundledWeComMarketingSkill({ userSkillsDir });
    expect(repaired.definitionHash).toBe(initial.definitionHash);
    expect(
      fs.existsSync(path.join(repaired.skillDir, 'SKILL.md.disabled')),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(repaired.skillDir, 'SKILL.md'), 'utf8'),
    ).toContain('美业门店本地内容营销');
  });

  test('fails closed on invalid skillId, traversal, or empty userSkillsDir', () => {
    const userSkillsDir = path.join(tempRoot, 'skills-fail-closed');

    expect(() =>
      ensureBundledWeComMarketingSkill({ userSkillsDir: '   ' }),
    ).toThrow();
    expect(() =>
      ensureBundledWeComMarketingSkill({
        userSkillsDir,
        skillId: 'training-knowledge',
      }),
    ).toThrow();
    expect(() =>
      ensureBundledWeComMarketingSkill({
        userSkillsDir,
        skillId: '../escape',
      }),
    ).toThrow();
  });
});
