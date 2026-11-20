import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEffectiveSkills } from './effective-skill-resolver.js';
import { validateSkillId, validateSkillPath } from './skill-utils.js';

export const DEFAULT_WECOM_MARKETING_SKILL_ID = 'beauty-local-content';

export const WECOM_SOFT_ROLES = [
  'marketing',
  'training',
  'manager_ops',
  'reception_ads',
] as const;

export type WeComSoftRole = (typeof WECOM_SOFT_ROLES)[number];

export const WECOM_ROLE_SKILL_IDS: Readonly<
  Record<WeComSoftRole, readonly string[]>
> = {
  marketing: [
    DEFAULT_WECOM_MARKETING_SKILL_ID,
    'vendor-content-strategy',
    'vendor-copywriting',
  ],
  training: ['beauty-training-coach'],
  manager_ops: ['beauty-manager-daily'],
  reception_ads: ['beauty-reception', 'beauty-ads-review'],
};

export const ALL_BUNDLED_WECOM_SKILL_IDS: readonly string[] =
  WECOM_SOFT_ROLES.flatMap((role) => WECOM_ROLE_SKILL_IDS[role]);

export interface EnsureBundledWeComMarketingSkillResult {
  readonly skillId: string;
  readonly skillDir: string;
  readonly definitionHash: string;
}

export function getBundledFrontClawSkillsRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'assets',
    'front-claw-skills',
  );
}

function resolveManagedSkills(root: string, ids: readonly string[]) {
  return resolveEffectiveSkills({
    layers: [{ source: 'managed', root }],
    managedPolicy: { mode: 'custom', ids: [...ids] },
    hostPolicy: { mode: 'disabled', ids: [] },
  });
}

function requireManagedSkills(
  root: string,
  ids: readonly string[],
  expectedHashes?: ReadonlyMap<string, string>,
): EnsureBundledWeComMarketingSkillResult[] {
  const manifest = resolveManagedSkills(root, ids);
  if (
    manifest.missingManagedSkillIds.length ||
    manifest.selected.length !== ids.length
  ) {
    throw new Error(
      'WeCom managed skill integrity verification failed: ' + ids.join(', '),
    );
  }

  return ids.map((skillId) => {
    const selected = manifest.selected.find(({ id }) => id === skillId);
    if (
      !selected ||
      (expectedHashes &&
        selected.definitionHash !== expectedHashes.get(skillId))
    ) {
      throw new Error(
        'WeCom managed skill hash verification failed: ' + skillId,
      );
    }
    return {
      skillId,
      skillDir: selected.path,
      definitionHash: selected.definitionHash,
    };
  });
}

const SKILL_TRANSACTION_PREFIX = '.wecom-bundled-skills-sync-';
const SKILL_TRANSACTION_NAME =
  /^\.wecom-bundled-skills-sync-(\d+)-(\d+)-[0-9a-f-]{36}(\.recovery|\.done)?$/;
const SKILL_INSTALLER_STARTED_AT = Math.trunc(performance.timeOrigin * 1000);

function skillTransactionOwnerIsAlive(pid: number, startedAt: number): boolean {
  // A container restart can reuse the current PID with the previous data volume.
  if (pid === process.pid) return startedAt === SKILL_INSTALLER_STARTED_AT;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeRetiredSkillTransaction(transactionDir: string): void {
  try {
    fs.rmSync(transactionDir, { force: true, recursive: true });
  } catch {
    // The transaction has already been committed or rolled back. A later
    // sync can retry removing its retired directory.
  }
}

function retireSkillTransaction(transactionDir: string): void {
  const retired = transactionDir.endsWith('.recovery')
    ? transactionDir.replace(/\.recovery$/, '.done')
    : transactionDir + '.done';
  fs.renameSync(transactionDir, retired);
  removeRetiredSkillTransaction(retired);
}

function skillDirectoryIdentity({ dev, ino }: fs.BigIntStats): string {
  return dev.toString() + ':' + ino.toString();
}

function rollBackSkillTransaction(
  userSkillsDir: string,
  transactionDir: string,
): void {
  const planPath = path.join(transactionDir, 'plan.json');
  if (!fs.lstatSync(planPath, { throwIfNoEntry: false })) return;

  const plan: unknown = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  if (
    !Array.isArray(plan) ||
    plan.some(
      (entry) =>
        !entry ||
        !ALL_BUNDLED_WECOM_SKILL_IDS.includes(entry.id) ||
        typeof entry.identity !== 'string' ||
        !/^\d+:\d+$/.test(entry.identity),
    ) ||
    new Set(plan.map(({ id }) => id)).size !== plan.length
  ) {
    throw new Error('Invalid WeCom skill transaction plan');
  }
  for (const directory of ['previous', 'staged']) {
    if (!fs.lstatSync(path.join(transactionDir, directory)).isDirectory()) {
      throw new Error('Invalid WeCom skill transaction directory');
    }
  }
  for (const { id, identity } of plan.reverse()) {
    const live = path.join(userSkillsDir, id);
    const staged = path.join(transactionDir, 'staged', id);
    const previous = path.join(transactionDir, 'previous', id);
    // A published directory is no longer in staging. Put it back before
    // restoring the backup so this rollback can itself be safely resumed.
    const liveStat = fs.lstatSync(live, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!fs.lstatSync(staged, { throwIfNoEntry: false }) && liveStat) {
      if (skillDirectoryIdentity(liveStat) !== identity) {
        throw new Error('WeCom skill changed during rollback: ' + id);
      }
      fs.renameSync(live, staged);
    }
    if (fs.lstatSync(previous, { throwIfNoEntry: false })) {
      if (fs.lstatSync(live, { throwIfNoEntry: false })) {
        throw new Error('WeCom skill changed during rollback: ' + id);
      }
      fs.renameSync(previous, live);
    }
  }
}

function recoverPreviousSkillTransactions(
  userSkillsDir: string,
  currentDir: string,
): void {
  const transactions = fs
    .readdirSync(userSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const match = SKILL_TRANSACTION_NAME.exec(name);
      const directory = path.join(userSkillsDir, name);
      return match && directory !== currentDir
        ? [
            {
              directory,
              pid: Number(match[1]),
              startedAt: Number(match[2]),
              phase: match[3],
            },
          ]
        : [];
    });
  // Register our own unique directory before the scan. Concurrent callers
  // see a live installer and fail closed, and a dead PID cannot hold the lock.
  if (
    transactions.some(
      ({ phase, pid, startedAt }) =>
        !phase && skillTransactionOwnerIsAlive(pid, startedAt),
    )
  ) {
    throw new Error('Another WeCom skill installation is in progress');
  }
  for (const { directory, phase } of transactions) {
    if (phase === '.done') {
      removeRetiredSkillTransaction(directory);
    } else {
      rollBackSkillTransaction(userSkillsDir, directory);
      retireSkillTransaction(directory);
    }
  }
}

function syncBundledSkillBatch(
  userSkillsDir: string,
  skillIds: readonly string[],
): EnsureBundledWeComMarketingSkillResult[] {
  const bundledRoot = getBundledFrontClawSkillsRoot();
  for (const skillId of skillIds) {
    const source = path.join(bundledRoot, skillId);
    if (!validateSkillPath(bundledRoot, source)) {
      throw new Error('Invalid bundled WeCom skill path: ' + skillId);
    }
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('Bundled WeCom skill directory missing: ' + skillId);
    }
    if (
      !fs
        .statSync(path.join(source, 'SKILL.md'), { throwIfNoEntry: false })
        ?.isFile()
    ) {
      throw new Error('Bundled WeCom skill SKILL.md missing: ' + skillId);
    }
    if (!validateSkillPath(userSkillsDir, path.join(userSkillsDir, skillId))) {
      throw new Error('Invalid target WeCom skill path: ' + skillId);
    }
  }
  const bundled = requireManagedSkills(bundledRoot, skillIds);
  const expectedHashes = new Map(
    bundled.map(({ skillId, definitionHash }) => [skillId, definitionHash]),
  );

  fs.mkdirSync(userSkillsDir, { recursive: true });
  const transactionDir = path.join(
    userSkillsDir,
    SKILL_TRANSACTION_PREFIX +
      process.pid +
      '-' +
      SKILL_INSTALLER_STARTED_AT +
      '-' +
      randomUUID(),
  );
  fs.mkdirSync(transactionDir);

  try {
    recoverPreviousSkillTransactions(userSkillsDir, transactionDir);
    const current = resolveManagedSkills(userSkillsDir, skillIds);
    const changes = bundled.filter(({ skillId, definitionHash }) => {
      const candidate = current.selected.find(({ id }) => id === skillId);
      const disabledMarker = path.join(
        userSkillsDir,
        skillId,
        'SKILL.md.disabled',
      );
      return (
        candidate?.definitionHash !== definitionHash ||
        fs.lstatSync(disabledMarker, { throwIfNoEntry: false }) !== undefined
      );
    });
    if (changes.length) {
      const staged = path.join(transactionDir, 'staged');
      const previous = path.join(transactionDir, 'previous');
      fs.mkdirSync(staged);
      fs.mkdirSync(previous);
      for (const { skillId, skillDir } of changes) {
        fs.cpSync(skillDir, path.join(staged, skillId), {
          recursive: true,
          dereference: true,
        });
      }
      const changedIds = changes.map(({ skillId }) => skillId);
      requireManagedSkills(staged, changedIds, expectedHashes);
      const plan = changedIds.map((id) => ({
        id,
        identity: skillDirectoryIdentity(
          fs.lstatSync(path.join(staged, id), { bigint: true }),
        ),
      }));
      const planDraft = path.join(transactionDir, 'plan.tmp');
      fs.writeFileSync(planDraft, JSON.stringify(plan));
      fs.renameSync(planDraft, path.join(transactionDir, 'plan.json'));

      for (const skillId of changedIds) {
        const target = path.join(userSkillsDir, skillId);
        if (fs.lstatSync(target, { throwIfNoEntry: false })) {
          fs.renameSync(target, path.join(previous, skillId));
        }
        fs.renameSync(path.join(staged, skillId), target);
      }
    }
    const installed = requireManagedSkills(
      userSkillsDir,
      skillIds,
      expectedHashes,
    );
    // The rename is the commit point. Reclaiming retired backups is cleanup.
    retireSkillTransaction(transactionDir);
    return installed;
  } catch (error) {
    try {
      rollBackSkillTransaction(userSkillsDir, transactionDir);
      retireSkillTransaction(transactionDir);
    } catch (rollbackError) {
      let recoveryDir = transactionDir;
      try {
        fs.renameSync(transactionDir, transactionDir + '.recovery');
        recoveryDir += '.recovery';
      } catch {
        // Retain the original transaction directory and report its path.
      }
      throw new AggregateError(
        [error, rollbackError],
        'WeCom managed skill rollback failed. Recovery data kept in ' +
          recoveryDir,
      );
    }
    throw error;
  }
}

/** Install the legacy Issue #7 marketing skill and verify its bundled hash. */
export function ensureBundledWeComMarketingSkill(params: {
  readonly userSkillsDir: string;
  readonly skillId?: string;
}): EnsureBundledWeComMarketingSkillResult {
  const rawUserSkillsDir =
    typeof params.userSkillsDir === 'string' ? params.userSkillsDir.trim() : '';
  if (!rawUserSkillsDir) {
    throw new Error('userSkillsDir is required for WeCom marketing skill sync');
  }
  const resolvedSkillId = (
    params.skillId ?? DEFAULT_WECOM_MARKETING_SKILL_ID
  ).trim();
  if (!resolvedSkillId || !validateSkillId(resolvedSkillId)) {
    throw new Error(
      'Invalid WeCom marketing skillId: ' + String(params.skillId),
    );
  }
  // Issue #7 callers retain the original single-skill surface.
  if (resolvedSkillId !== DEFAULT_WECOM_MARKETING_SKILL_ID) {
    throw new Error(
      'Bundled WeCom skill directory missing: ' + resolvedSkillId,
    );
  }
  return syncBundledSkillBatch(path.resolve(rawUserSkillsDir), [
    resolvedSkillId,
  ])[0]!;
}

/** Explicit IDs override the role list. Omit the role to use marketing. */
export function ensureBundledWeComRoleSkills(params: {
  readonly userSkillsDir: string;
  readonly role?: WeComSoftRole;
  readonly skillIds?: readonly string[];
}): {
  readonly role: WeComSoftRole;
  readonly skillIds: readonly string[];
  readonly installed: ReadonlyArray<EnsureBundledWeComMarketingSkillResult>;
} {
  const role = params.role ?? 'marketing';
  if (!WECOM_SOFT_ROLES.includes(role)) {
    throw new Error('Invalid WeCom soft role: ' + role);
  }
  const requestedIds = params.skillIds ?? WECOM_ROLE_SKILL_IDS[role];
  if (!Array.isArray(requestedIds) || !requestedIds.length) {
    throw new Error('At least one bundled WeCom skillId is required');
  }
  const skillIds = [...new Set(requestedIds)];
  for (const skillId of skillIds) {
    if (!ALL_BUNDLED_WECOM_SKILL_IDS.includes(skillId)) {
      throw new Error('Invalid bundled WeCom skillId: ' + skillId);
    }
  }
  if (
    typeof params.userSkillsDir !== 'string' ||
    !params.userSkillsDir.trim()
  ) {
    throw new Error('userSkillsDir is required for WeCom role skill sync');
  }
  const installed = syncBundledSkillBatch(
    path.resolve(params.userSkillsDir.trim()),
    skillIds,
  );
  return { role, skillIds, installed };
}

interface BundledTrainingDocument {
  readonly sha256: string;
  readonly fileName: string;
  readonly category: string;
  readonly evidenceLevel: 'secondary_summary' | 'provided_training_text';
  readonly sourceText: string;
  readonly redactExcerptLines?: ReadonlyArray<readonly [number, number]>;
}

interface WeComTrainingSection {
  readonly fileName: string;
  readonly category: string;
  readonly heading: string;
  readonly id: string;
}

const TRAINING_RESULT_LIMIT = 6;
const TRAINING_KEYWORDS = [
  '家访',
  '五步法',
  '企业诊断',
  '指导员',
  '带教',
  '董事长',
  '店长',
  '培养',
  '考核',
  '试卷',
  '旬总结',
  '数据',
  '复盘',
  '规则',
  '制度',
  '积分',
  '作战地图',
  '风险',
  '热力图',
  '鱼骨图',
  '客户盘点',
  '信念',
  '挂零',
  '大单',
  '客户',
  '培训',
  '课程',
  '目标',
  '班级',
  '成长',
  '团队',
  '金字塔',
  '翻译官',
  '运动',
  '大脑',
  '根源',
];

// Keep parsing and ranking in parity with Front Claw's training-knowledge.ts.
// Its parser is scoped to its own web workspace and lies outside this build's rootDir.
function parseBundledTrainingDocument(document: BundledTrainingDocument) {
  const {
    sourceText,
    sha256,
    fileName,
    category,
    evidenceLevel,
    redactExcerptLines = [],
  } = document;
  if (
    typeof sourceText !== 'string' ||
    !sourceText.trim() ||
    Buffer.byteLength(sourceText) > 256_000 ||
    typeof fileName !== 'string' ||
    !fileName.endsWith('.md') ||
    /[\\/:]/.test(fileName) ||
    !['资料总览', '家访实操', '认知成长', '组织诊断', '案例研讨'].includes(
      category,
    ) ||
    !['secondary_summary', 'provided_training_text'].includes(evidenceLevel)
  ) {
    throw new Error('invalid_training_source');
  }
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    createHash('sha256').update(sourceText).digest('hex') !== sha256
  ) {
    throw new Error('training_source_changed');
  }

  const lines = sourceText.split(/\r?\n/);
  const title = lines
    .find((line) => /^#\s+/.test(line))
    ?.replace(/^#\s+/, '')
    .trim();
  const starts = lines.flatMap((line, index) =>
    /^#{2,3}\s+/.test(line) ? [index] : [],
  );
  if (!title || !starts.length) {
    throw new Error('invalid_training_source');
  }
  const redactedLines = new Set<number>();
  for (const [first, last] of redactExcerptLines) {
    if (
      !Number.isInteger(first) ||
      !Number.isInteger(last) ||
      first < 1 ||
      first > last ||
      last > lines.length
    ) {
      throw new Error('invalid_training_redaction');
    }
    for (let line = first; line <= last; line++) redactedLines.add(line);
  }

  let chapter = '';
  const sections = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const line = lines[start]!;
    const subsection = /^###\s/.test(line);
    const label = line.replace(/^#{2,3}\s+/, '');
    if (!subsection) chapter = label;
    return {
      id: sha256 + ':L' + (start + 1) + '-' + end,
      fileName,
      category,
      heading: subsection ? chapter + ' / ' + label : chapter,
      startLine: start + 1,
      text: lines.slice(start, end).join('\n'),
      excerpt: lines
        .slice(start + 1, end)
        .map((value, offset) =>
          redactedLines.has(start + 2 + offset) ? '[已脱敏]' : value,
        )
        .join('\n')
        .trim(),
      evidenceLevel,
    };
  });
  return { title, sections };
}

function loadBundledTrainingDocuments() {
  const catalogPath = path.join(
    getBundledFrontClawSkillsRoot(),
    '..',
    'front-claw-training',
    'catalog.json',
  );
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as {
    usage: string;
    documents: BundledTrainingDocument[];
  };
  if (
    catalog.usage !== 'teaching_training_only' ||
    !Array.isArray(catalog.documents) ||
    catalog.documents.length !== 11 ||
    new Set(catalog.documents.map(({ sha256 }) => sha256)).size !== 11 ||
    new Set(catalog.documents.map(({ fileName }) => fileName)).size !== 11
  ) {
    throw new Error('invalid_training_library');
  }
  return catalog.documents.map(parseBundledTrainingDocument);
}

/**
 * Search tenant-neutral, bundled teaching materials. The caller authorizes
 * access in its account/workspace; neither identifier enters the text or index.
 */
export function buildWeComTrainingKnowledgeContext(params: {
  readonly query: string;
  readonly accountId?: string;
  readonly workspaceJid?: string;
  readonly maxSections?: number;
}): {
  readonly status: 'matched' | 'no_match' | 'primary_source_missing';
  readonly formattedContext: string;
  readonly matchedSections: ReadonlyArray<WeComTrainingSection>;
} {
  if (typeof params.query !== 'string' || params.query.length > 2_000) {
    throw new Error('invalid_training_query');
  }
  const query = params.query.trim();
  if (!query) {
    return { status: 'no_match', formattedContext: '', matchedSections: [] };
  }
  const limit = Number.isFinite(params.maxSections)
    ? Math.max(
        0,
        Math.min(TRAINING_RESULT_LIMIT, Math.trunc(params.maxSections!)),
      )
    : TRAINING_RESULT_LIMIT;
  const tokens = [
    ...new Set([
      ...query.split(/[\s，,、]+/).filter((token) => token.length > 1),
      ...TRAINING_KEYWORDS.filter((keyword) => query.includes(keyword)),
    ]),
  ];
  const classes = Array.from(
    query.matchAll(/(\d{1,4})班/g),
    (match) => new RegExp('(?:^|[^0-9])' + match[1] + '班'),
  );
  const needsPrimary =
    classes.length > 0 ||
    /词频|出现.*次|频率|真实案例|157|第\s*\d+\s*旬|PK|对比|vs/i.test(query);

  const matches = loadBundledTrainingDocuments()
    .flatMap(({ title, sections }) => {
      const titleRank =
        tokens.filter((token) => title.includes(token)).length * 2;
      return sections
        .filter(({ text }) => classes.every((pattern) => pattern.test(text)))
        .map((section) => ({
          ...section,
          score: tokens.reduce(
            (score, token) =>
              score +
              (section.heading.includes(token) ? 5 : 0) +
              (section.text.includes(token) ? 1 : 0),
            0,
          ),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.startLine - b.startLine)
        .slice(0, TRAINING_RESULT_LIMIT)
        .map((section) => ({ ...section, rank: section.score + titleRank }));
    })
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        a.fileName.localeCompare(b.fileName) ||
        a.startLine - b.startLine,
    )
    .slice(0, limit);
  const matchedSections = matches.map(
    ({ fileName, category, heading, id }) => ({
      fileName,
      category,
      heading,
      id,
    }),
  );

  if (needsPrimary) {
    return {
      status: 'primary_source_missing',
      formattedContext:
        '【受控培训参考】缺少可核验的一手资料。请说明所需原始记录，勿根据培训资料推断精确次数、频率或案例比较结论。',
      matchedSections,
    };
  }
  if (!matches.length) {
    return { status: 'no_match', formattedContext: '', matchedSections };
  }
  const references = matches.map(
    ({ fileName, category, id, heading, excerpt, evidenceLevel }) =>
      [
        '来源文件 ' +
          fileName +
          '｜' +
          category +
          '｜' +
          (evidenceLevel === 'secondary_summary' ? '二手摘要' : '培训文本'),
        '章节 ' + heading + '｜' + id,
        excerpt,
      ].join('\n'),
  );
  return {
    status: 'matched',
    formattedContext: [
      '【受控培训参考】以下摘录为教学材料，仅供解释与演练。请引用支持答复的章节及行号。历史案例和数字不能充当当前门店事实、获批制度或一手统计证据。',
      ...references,
      '【培训参考结束】',
    ].join('\n\n'),
    matchedSections,
  };
}
