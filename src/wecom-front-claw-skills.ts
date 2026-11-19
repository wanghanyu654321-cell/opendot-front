import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEffectiveSkills } from './effective-skill-resolver.js';
import { validateSkillId, validateSkillPath } from './skill-utils.js';

export const DEFAULT_WECOM_MARKETING_SKILL_ID = 'beauty-local-content';

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

function resolveBundledMarketingSkillSource(skillId: string): {
  bundledRoot: string;
  sourceSkillDir: string;
  definitionHash: string;
} {
  const bundledRoot = getBundledFrontClawSkillsRoot();
  const sourceSkillDir = path.join(bundledRoot, skillId);
  if (!validateSkillPath(bundledRoot, sourceSkillDir)) {
    throw new Error(`Invalid bundled WeCom skill path: ${skillId}`);
  }
  if (
    !fs.existsSync(sourceSkillDir) ||
    !fs.statSync(sourceSkillDir).isDirectory()
  ) {
    throw new Error(`Bundled WeCom skill directory missing: ${skillId}`);
  }
  const sourceSkillMd = path.join(sourceSkillDir, 'SKILL.md');
  if (!fs.existsSync(sourceSkillMd) || !fs.statSync(sourceSkillMd).isFile()) {
    throw new Error(`Bundled WeCom skill SKILL.md missing: ${skillId}`);
  }

  const manifest = resolveEffectiveSkills({
    layers: [{ source: 'managed', root: bundledRoot }],
    managedPolicy: { mode: 'custom', ids: [skillId] },
    hostPolicy: { mode: 'disabled', ids: [] },
  });
  const selected = manifest.selected.find((entry) => entry.id === skillId);
  if (
    manifest.missingManagedSkillIds.length > 0 ||
    manifest.selected.length !== 1 ||
    !selected
  ) {
    throw new Error(
      `Bundled WeCom skill failed integrity verification: ${skillId}`,
    );
  }

  return {
    bundledRoot,
    sourceSkillDir,
    definitionHash: selected.definitionHash,
  };
}

function pathExistsOrSymlink(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function installBundledSkillAtomically(
  sourceSkillDir: string,
  userSkillsDir: string,
  skillId: string,
): void {
  const targetSkillDir = path.join(userSkillsDir, skillId);
  const suffix = `${process.pid}-${randomUUID()}`;
  const stagingDir = path.join(userSkillsDir, `.staging-${skillId}-${suffix}`);
  const previousDir = path.join(
    userSkillsDir,
    `.previous-${skillId}-${suffix}`,
  );

  let movedExisting = false;
  try {
    fs.cpSync(sourceSkillDir, stagingDir, {
      recursive: true,
      force: true,
      dereference: true,
    });
    if (pathExistsOrSymlink(targetSkillDir)) {
      fs.renameSync(targetSkillDir, previousDir);
      movedExisting = true;
    }
    fs.renameSync(stagingDir, targetSkillDir);
    if (movedExisting) {
      fs.rmSync(previousDir, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (movedExisting && !pathExistsOrSymlink(targetSkillDir)) {
      try {
        fs.renameSync(previousDir, targetSkillDir);
      } catch {
        /* best-effort rollback */
      }
    }
    throw error;
  }
}

function verifyInstalledManagedSkill(
  userSkillsDir: string,
  skillId: string,
  expectedHash: string,
): EnsureBundledWeComMarketingSkillResult {
  const manifest = resolveEffectiveSkills({
    layers: [{ source: 'managed', root: userSkillsDir }],
    managedPolicy: { mode: 'custom', ids: [skillId] },
    hostPolicy: { mode: 'disabled', ids: [] },
  });
  const selected = manifest.selected.find((entry) => entry.id === skillId);
  if (
    manifest.missingManagedSkillIds.length > 0 ||
    manifest.selected.length !== 1 ||
    !selected
  ) {
    throw new Error(
      `Installed WeCom marketing skill missing or disabled: ${manifest.missingManagedSkillIds.join(', ') || skillId}`,
    );
  }
  if (selected.definitionHash !== expectedHash) {
    throw new Error(
      `Installed WeCom marketing skill hash mismatch for ${skillId}`,
    );
  }
  return {
    skillId,
    skillDir: selected.path,
    definitionHash: selected.definitionHash,
  };
}

/**
 * Idempotently sync the bundled WeCom marketing skill into `userSkillsDir`
 * and verify it fail-closed with `resolveEffectiveSkills`.
 */
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
      `Invalid WeCom marketing skillId: ${String(params.skillId)}`,
    );
  }

  const { sourceSkillDir, definitionHash } =
    resolveBundledMarketingSkillSource(resolvedSkillId);

  const normalizedUserSkillsDir = path.resolve(rawUserSkillsDir);
  const targetSkillDir = path.join(normalizedUserSkillsDir, resolvedSkillId);
  if (!validateSkillPath(normalizedUserSkillsDir, targetSkillDir)) {
    throw new Error(`Invalid target WeCom skill path: ${resolvedSkillId}`);
  }
  fs.mkdirSync(normalizedUserSkillsDir, { recursive: true });

  const currentManifest = resolveEffectiveSkills({
    layers: [{ source: 'managed', root: normalizedUserSkillsDir }],
    managedPolicy: { mode: 'custom', ids: [resolvedSkillId] },
    hostPolicy: { mode: 'disabled', ids: [] },
  });
  const currentSelected = currentManifest.selected.find(
    (entry) => entry.id === resolvedSkillId,
  );
  const hasDisabledMarker = pathExistsOrSymlink(
    path.join(targetSkillDir, 'SKILL.md.disabled'),
  );
  const alreadySynced =
    currentManifest.missingManagedSkillIds.length === 0 &&
    currentManifest.selected.length === 1 &&
    currentSelected?.definitionHash === definitionHash &&
    !hasDisabledMarker;

  if (!alreadySynced) {
    installBundledSkillAtomically(
      sourceSkillDir,
      normalizedUserSkillsDir,
      resolvedSkillId,
    );
  }

  return verifyInstalledManagedSkill(
    normalizedUserSkillsDir,
    resolvedSkillId,
    definitionHash,
  );
}
