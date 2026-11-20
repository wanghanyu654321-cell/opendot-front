import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createTrainingSummaryService,
  parseTrainingSummary,
} from '../packages/front-claw/src/role-eval/training-knowledge.js';
import { resolveEffectiveSkills } from '../src/effective-skill-resolver.js';
import { parseFrontmatter, scanSkillDirectory } from '../src/skill-utils.js';
import {
  ALL_BUNDLED_WECOM_SKILL_IDS,
  DEFAULT_WECOM_MARKETING_SKILL_ID,
  WECOM_ROLE_SKILL_IDS,
  WECOM_SOFT_ROLES,
  buildWeComTrainingKnowledgeContext,
  ensureBundledWeComMarketingSkill,
  ensureBundledWeComRoleSkills,
  getBundledFrontClawSkillsRoot,
} from '../src/wecom-front-claw-skills.js';

let tempRoot: string;
const roles = {
  marketing: [
    'beauty-local-content',
    'vendor-content-strategy',
    'vendor-copywriting',
  ],
  training: ['beauty-training-coach'],
  manager_ops: ['beauty-manager-daily'],
  reception_ads: ['beauty-reception', 'beauty-ads-review'],
} as const;
const bundledRoot = getBundledFrontClawSkillsRoot();
const trainingRoot = path.join(bundledRoot, '..', 'front-claw-training');

beforeEach(() => {
  tempRoot = fs.mkdtempSync(
    path.resolve(bundledRoot, '../../node_modules/.wecom-skills-'),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('WeCom Front Claw bundled skills', () => {
  test('defines four roles with exactly seven bundled skills', () => {
    expect(WECOM_SOFT_ROLES).toEqual(Object.keys(roles));
    expect(WECOM_ROLE_SKILL_IDS).toEqual(roles);
    expect(ALL_BUNDLED_WECOM_SKILL_IDS).toEqual(Object.values(roles).flat());
    const skillEntries = fs
      .readdirSync(bundledRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(skillEntries.sort()).toEqual(
      [...ALL_BUNDLED_WECOM_SKILL_IDS].sort(),
    );
    expect(DEFAULT_WECOM_MARKETING_SKILL_ID).toBe('beauty-local-content');
  });

  test.each(Object.values(roles).flat())(
    '%s has clean frontmatter and explicit safety guardrails',
    (id) => {
      const content = fs.readFileSync(
        path.join(bundledRoot, id, 'SKILL.md'),
        'utf8',
      );
      const frontmatter = parseFrontmatter(content);

      expect(Object.keys(frontmatter).sort()).toEqual(['description', 'name']);
      expect(frontmatter.name).toBe(id);
      expect(frontmatter.description.length).toBeGreaterThan(20);
      expect(frontmatter['allowed-tools']).toBeUndefined();

      expect(content).toMatch(/^## 安全红线/m);
      expect(content).toContain('严禁伪造');
      expect(content).toContain('入账');
      expect(content).toContain('预约');
      expect(content).toContain('写库');
      expect(content).toMatch(/自动(?:外发|发送|发布)/);
      expect(content).toMatch(/\[待确认[^\]]+\]/);
      expect(content).not.toMatch(
        /\bR[3-6]\b|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/|\b(?:sk-[\w-]{15,}|ghp_[\w]{20,}|AKIA[A-Z0-9]{16})\b/i,
      );

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
      expect(scanned.find((entry) => entry.id === id)).toMatchObject({
        id,
        name: id,
        enabled: true,
        allowedTools: [],
      });
    },
  );

  test.each(
    Object.entries(roles) as Array<[keyof typeof roles, readonly string[]]>,
  )('installs and repairs %s with the bundled hashes', (role, skillIds) => {
    const userSkillsDir = path.join(tempRoot, 'skills');
    const first = ensureBundledWeComRoleSkills({ userSkillsDir, role });
    expect(first).toMatchObject({ role, skillIds });
    const before = first.installed.map(
      ({ skillDir }) => fs.statSync(path.join(skillDir, 'SKILL.md')).mtimeMs,
    );
    expect(ensureBundledWeComRoleSkills({ userSkillsDir, role })).toEqual(
      first,
    );
    expect(
      first.installed.map(
        ({ skillDir }) => fs.statSync(path.join(skillDir, 'SKILL.md')).mtimeMs,
      ),
    ).toEqual(before);

    for (const { skillDir } of first.installed) {
      fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\nTampered\n');
      fs.renameSync(
        path.join(skillDir, 'SKILL.md'),
        path.join(skillDir, 'SKILL.md.disabled'),
      );
    }
    expect(ensureBundledWeComRoleSkills({ userSkillsDir, role })).toEqual(
      first,
    );
    const resolve = (root: string) =>
      resolveEffectiveSkills({
        layers: [{ source: 'managed', root }],
        managedPolicy: { mode: 'custom', ids: [...skillIds] },
        hostPolicy: { mode: 'disabled' },
      });
    const installed = resolve(userSkillsDir);
    expect(installed.missingManagedSkillIds).toEqual([]);
    expect(
      installed.selected.map(({ id, definitionHash }) => ({
        id,
        definitionHash,
      })),
    ).toEqual(
      resolve(bundledRoot).selected.map(({ id, definitionHash }) => ({
        id,
        definitionHash,
      })),
    );
    expect(fs.readdirSync(userSkillsDir).sort()).toEqual([...skillIds].sort());
  });

  test('supports explicit IDs without replacing other managed skills', () => {
    const userSkillsDir = path.join(tempRoot, 'skills');
    const marketing = ensureBundledWeComMarketingSkill({ userSkillsDir });
    const result = ensureBundledWeComRoleSkills({
      userSkillsDir,
      role: 'marketing',
      skillIds: [
        'beauty-reception',
        'beauty-training-coach',
        'beauty-reception',
      ],
    });
    expect(result.role).toBe('marketing');
    expect(result.skillIds).toEqual([
      'beauty-reception',
      'beauty-training-coach',
    ]);
    expect(result.installed.map(({ skillId }) => skillId)).toEqual(
      result.skillIds,
    );
    expect(fs.existsSync(marketing.skillDir)).toBe(true);
    expect(ensureBundledWeComRoleSkills({ userSkillsDir }).skillIds).toEqual(
      roles.marketing,
    );
  });

  test('validates a whole explicit selection before installing any skill', () => {
    const userSkillsDir = path.join(tempRoot, 'skills');
    for (const invalid of ['training-knowledge', '../escape']) {
      expect(() =>
        ensureBundledWeComRoleSkills({
          userSkillsDir,
          skillIds: ['beauty-reception', invalid],
        }),
      ).toThrow(/skillId/i);
    }
    expect(() =>
      ensureBundledWeComRoleSkills({ userSkillsDir, skillIds: [] }),
    ).toThrow();
    expect(() =>
      ensureBundledWeComRoleSkills({
        userSkillsDir,
        role: 'toString' as 'marketing',
      }),
    ).toThrow();
    expect(fs.existsSync(userSkillsDir)).toBe(false);
  });

  test('rolls back both replaced and newly installed skills when publishing fails', () => {
    const userSkillsDir = path.join(tempRoot, 'skills');
    const existing = ensureBundledWeComMarketingSkill({ userSkillsDir });
    const existingMd = path.join(existing.skillDir, 'SKILL.md');
    const oldContent =
      fs.readFileSync(existingMd, 'utf8') + '\nPrior version\n';
    fs.writeFileSync(existingMd, oldContent);

    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === path.join(userSkillsDir, 'vendor-copywriting')) {
        expect(
          fs.existsSync(
            path.join(userSkillsDir, 'vendor-content-strategy', 'SKILL.md'),
          ),
        ).toBe(true);
        throw new Error('publication failed');
      }
      rename(from, to);
    });
    expect(() => ensureBundledWeComRoleSkills({ userSkillsDir })).toThrow(
      'publication failed',
    );
    expect(fs.readFileSync(existingMd, 'utf8')).toBe(oldContent);
    expect(fs.readdirSync(userSkillsDir)).toEqual([existing.skillId]);
  });

  test('recovers partial publication left by an interrupted installer before another role sync', () => {
    const userSkillsDir = path.join(tempRoot, 'skills');
    const existing = ensureBundledWeComMarketingSkill({ userSkillsDir });
    const previousMd = path.join(existing.skillDir, 'SKILL.md');
    fs.appendFileSync(previousMd, '\nPrior version\n');
    const oldContent = fs.readFileSync(previousMd, 'utf8');

    // A restarted container can reuse the same PID while retaining the data directory.
    const departedProcess = process.pid;
    const priorStart = Math.trunc(performance.timeOrigin * 1000) - 1;
    const transaction = path.join(
      userSkillsDir,
      `.wecom-bundled-skills-sync-${departedProcess}-${priorStart}-00000000-0000-4000-8000-000000000001`,
    );
    const previous = path.join(transaction, 'previous');
    const staged = path.join(transaction, 'staged');
    fs.mkdirSync(previous, { recursive: true });
    fs.mkdirSync(staged);
    fs.renameSync(existing.skillDir, path.join(previous, existing.skillId));
    fs.cpSync(path.join(bundledRoot, existing.skillId), existing.skillDir, {
      recursive: true,
    });
    const addedSkill = 'vendor-content-strategy';
    fs.cpSync(
      path.join(bundledRoot, addedSkill),
      path.join(userSkillsDir, addedSkill),
      { recursive: true },
    );
    fs.cpSync(
      path.join(bundledRoot, 'vendor-copywriting'),
      path.join(staged, 'vendor-copywriting'),
      { recursive: true },
    );
    const entries = roles.marketing.map((id) => {
      const { dev, ino } = fs.lstatSync(
        path.join(id === 'vendor-copywriting' ? staged : userSkillsDir, id),
        { bigint: true },
      );
      return { id, identity: dev.toString() + ':' + ino.toString() };
    });
    fs.writeFileSync(
      path.join(transaction, 'plan.json'),
      JSON.stringify(entries),
    );

    // A separate managed-skill writer can publish a replacement before recovery.
    const otherVersion = path.join(tempRoot, 'other-version');
    const newTarget = path.join(userSkillsDir, addedSkill);
    fs.renameSync(newTarget, otherVersion);
    fs.mkdirSync(newTarget);
    const importedFile = path.join(newTarget, 'SKILL.md');
    fs.writeFileSync(importedFile, '# Separately imported skill');
    expect(() =>
      ensureBundledWeComRoleSkills({ userSkillsDir, role: 'training' }),
    ).toThrow('WeCom skill changed during rollback');
    expect(fs.readFileSync(importedFile, 'utf8')).toBe(
      '# Separately imported skill',
    );
    expect(
      fs.existsSync(path.join(previous, existing.skillId, 'SKILL.md')),
    ).toBe(true);
    fs.renameSync(newTarget, path.join(tempRoot, 'imported-version'));
    fs.renameSync(otherVersion, newTarget);

    const result = ensureBundledWeComRoleSkills({
      userSkillsDir,
      role: 'training',
    });
    expect(result.skillIds).toEqual(roles.training);
    expect(fs.readFileSync(previousMd, 'utf8')).toBe(oldContent);
    expect(fs.readdirSync(userSkillsDir).sort()).toEqual(
      [existing.skillId, ...roles.training].sort(),
    );
  });

  test('reports a verified installation even if removing its retired transaction fails', () => {
    const userSkillsDir = path.join(tempRoot, 'skills');
    const remove = fs.rmSync;
    const mock = vi
      .spyOn(fs, 'rmSync')
      .mockImplementation((target, options) => {
        if (path.dirname(String(target)) === userSkillsDir) {
          throw new Error('transaction cleanup failed');
        }
        remove(target, options);
      });
    const result = ensureBundledWeComRoleSkills({
      userSkillsDir,
      role: 'training',
    });
    expect(mock).toHaveBeenCalled();
    mock.mockRestore();
    expect(
      ensureBundledWeComRoleSkills({ userSkillsDir, role: 'training' }),
    ).toEqual(result);
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
    const second = ensureBundledWeComMarketingSkill({
      userSkillsDir,
      skillId: ' beauty-local-content ',
    });

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
        skillId: 'beauty-training-coach',
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

describe('WeCom Front Claw bundled training knowledge', () => {
  const scope = { accountId: 'wecom-test', workspaceJid: 'web:local-training' };
  const catalogPath = path.join(trainingRoot, 'catalog.json');
  const makeReferenceService = () => {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const documents = catalog.documents;
    const trainingDir = path.join(tempRoot, 'reference-training');
    fs.mkdirSync(trainingDir);
    for (const { sourceText, sha256, fileName } of documents) {
      const parsed = parseTrainingSummary(sourceText, sha256, scope, fileName);
      expect(parsed.sections.length).toBeGreaterThan(0);
      fs.writeFileSync(
        path.join(trainingDir, `summary-${sha256}.json`),
        JSON.stringify({ sourceText, sha256, scope }),
      );
    }
    fs.writeFileSync(
      path.join(trainingDir, 'approval.json'),
      JSON.stringify({
        kind: 'user_provided_training_library',
        usage: catalog.usage,
        documents,
        scope,
      }),
    );
    return createTrainingSummaryService(trainingDir, scope);
  };

  test('bundles exactly eleven parser-valid approved documents without tenant bindings', () => {
    const service = makeReferenceService();
    expect(service.overview()).toMatchObject({
      available: true,
      documentsAvailable: 11,
      caseDocumentsAvailable: 0,
    });
    const rawCatalog = fs.readFileSync(catalogPath, 'utf8');
    expect(rawCatalog).not.toMatch(
      /local-owner|web:local-training|"accountId"|"workspaceJid"/,
    );
  });

  test.each([
    ['家访 五步法', '家访五步法'],
    ['企业诊断', '知识库总体概览'],
    ['带教', '岗位手册层'],
    ['作战地图', '作战地图'],
  ])(
    'matches %s in ranked document sections with the canonical IDs',
    (query, heading) => {
      const service = makeReferenceService();
      const accountId = 'wecom-private-tenant';
      const workspaceJid = 'wecom:private-workspace';
      const result = buildWeComTrainingKnowledgeContext({
        query,
        accountId,
        workspaceJid,
      });
      const expected = service
        .search(query)
        .matches.map(({ fileName, category, id, heading }) => ({
          fileName,
          category,
          id,
          heading,
        }));
      expect(result.status).toBe('matched');
      expect(result.matchedSections).toEqual(expected);
      expect(
        result.matchedSections.some((match) => match.heading.includes(heading)),
      ).toBe(true);
      expect(result.formattedContext).toContain(expected[0].fileName);
      expect(result.formattedContext).toContain(expected[0].id);
      expect(result.formattedContext).toContain(query.split(' ').at(-1));
      expect(result.formattedContext).not.toContain(accountId);
      expect(result.formattedContext).not.toContain(workspaceJid);
      expect(
        buildWeComTrainingKnowledgeContext({ query, maxSections: 1 })
          .matchedSections,
      ).toEqual(expected.slice(0, 1));
    },
  );

  test.each([
    '指导员词频',
    '110班 作战地图',
    '第 2 旬 带教',
    '家访对比',
    '真实案例',
    '157',
  ])(
    'requires primary material for %s even if summaries contain partial evidence',
    (query) => {
      const result = buildWeComTrainingKnowledgeContext({ query });
      expect(result.status).toBe('primary_source_missing');
      expect(result.formattedContext).toContain('一手资料');
      for (const match of result.matchedSections) {
        expect(result.formattedContext).not.toContain(match.id);
      }
    },
  );

  test('leaves context empty with no matching evidence', () => {
    expect(buildWeComTrainingKnowledgeContext({ query: '量子隧穿χζ' })).toEqual(
      {
        status: 'no_match',
        formattedContext: '',
        matchedSections: [],
      },
    );
  });

  test('redacts identifiable people and case details in the formatted reference', () => {
    const { documents } = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const { sourceText } = documents.find(
      ({ fileName }: { fileName: string }) =>
        fileName.includes('大单客户精准画像'),
    );
    const firstCase = sourceText
      .split(/\r?\n/)
      .find((line: string) => /^\| 1 \| \d+班 \|/.test(line));
    const people = firstCase.split('|')[3].trim().split('×');
    expect(people).toHaveLength(2);

    const result = buildWeComTrainingKnowledgeContext({
      query: '大单客户 经典成交案例',
    });
    expect(result.status).toBe('matched');
    expect(
      result.matchedSections.some(({ heading }) =>
        heading.includes('经典成交案例'),
      ),
    ).toBe(true);
    expect(result.formattedContext).toContain('已脱敏');
    for (const person of people) {
      expect(result.formattedContext).not.toContain(person);
    }
  });

  test('rejects a changed training body before using it as evidence', () => {
    const readFile = fs.readFileSync;
    const catalog = JSON.parse(readFile(catalogPath, 'utf8'));
    catalog.documents[0].sourceText += '\n篡改内容';
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
      file === catalogPath ? JSON.stringify(catalog) : readFile(file, options),
    );
    expect(() => buildWeComTrainingKnowledgeContext({ query: '家访' })).toThrow(
      'training_source_changed',
    );
  });
});
