/**
 * src/terminal/loader.ts
 * Load and parse .md skill files with YAML frontmatter.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import { childLogger } from '../utils/logger.js';
import type { SkillDefinition, LoadedSkill, SkillArgument } from './types.js';
import { validateSkillDefinition } from './validator.js';

const log = childLogger({ module: 'terminal:loader' });

/**
 * Load a single skill file and parse its YAML frontmatter.
 */
export async function loadSkillFile(filePath: string): Promise<LoadedSkill> {
  const content = await fs.readFile(filePath, 'utf-8');
  const { data } = matter(content);

// Parse YAML frontmatter
const frontmatter = data as Record<string, unknown>;

  // Extract skill name from filename
  const name = path.basename(filePath, '.md');

  // Build arguments array
  const argsList: SkillArgument[] = [];
  if (Array.isArray(frontmatter.arguments)) {
    for (const arg of frontmatter.arguments as Record<string, unknown>[]) {
      const skillArg: SkillArgument = {
        name: String(arg.name ?? ''),
        type: String(arg.type ?? 'string'),
        required: Boolean(arg.required),
        description: typeof arg.description === 'string' ? arg.description : '',
            default: typeof arg.default === 'string' ? arg.default : undefined,
      };
      argsList.push(skillArg);
    }
  }

  // Build env object
  const envObj: Record<string, string> = {};
  if (typeof frontmatter.env === 'object' && frontmatter.env !== null) {
    for (const [k, v] of Object.entries(frontmatter.env)) {
      envObj[k] = String(v);
    }
  }

  log.info({ envObj, rawEnv: frontmatter.env }, 'Loaded skill env');

  // Build skill definition
  const definition: SkillDefinition = {
    name,
    description: typeof frontmatter.description === 'string'
      ? frontmatter.description
      : '',
    command: typeof frontmatter.command === 'string'
      ? frontmatter.command
      : '',
    args: Array.isArray(frontmatter.args)
      ? frontmatter.args.map(String)
      : [],
    arguments: argsList,
    cwd: typeof frontmatter.cwd === 'string'
      ? frontmatter.cwd
      : '',
    env: envObj,
    timeout: typeof frontmatter.timeout === 'number'
      ? frontmatter.timeout
      : 0,
    requiresShellMode: frontmatter.requiresShellMode === true ? true : false,
  };

   // Parse shellQuoting rules from YAML frontmatter
   // Rules are position-based: each rule specifies whether an argument at a given
   // position should be quoted or not. Supports positive indices (0, 1, 2...) and
   // negative indices (-1 for last, -2 for second-to-last, etc.).
   // Load-time validation ensures no duplicate positions are specified.
   if (frontmatter.shellQuoting && typeof frontmatter.shellQuoting === 'object') {
    const sq = frontmatter.shellQuoting as { argRules?: unknown };
    if (sq.argRules && Array.isArray(sq.argRules)) {
      const seenPositions = new Set<number>();
      const rules = sq.argRules.map((rule: unknown) => {
        if (typeof rule !== 'object' || rule === null) {
          throw new Error(`Invalid shellQuoting rule in ${filePath}: rule must be an object`);
        }
        const r = rule as { position?: unknown; quote?: unknown };
        if (typeof r.position !== 'number') {
          throw new Error(`Invalid shellQuoting rule in ${filePath}: position must be a number`);
        }
        if (seenPositions.has(r.position)) {
          throw new Error(`Duplicate position ${r.position} in shellQuoting rules for skill ${name}`);
        }
        seenPositions.add(r.position);
        return {
          position: r.position,
          quote: r.quote === true
        };
      });
      definition.shellQuoting = { argRules: rules };
    }
  }

  // Validate the skill definition
  const validation = validateSkillDefinition(definition);
  if (!validation.valid) {
    throw new Error(
      `Invalid skill definition in ${filePath}: ${validation.errors.join('; ')}`
    );
  }

  log.debug({ skill: name, filePath }, 'Loaded skill file');

  return { definition, filePath };
}

/**
 * Load all skill files from the skills directory.
 */
export async function loadAllSkills(skillsPath: string): Promise<Map<string, LoadedSkill>> {
  const skills = new Map<string, LoadedSkill>();

  try {
    const entries = await fs.readdir(skillsPath, { withFileTypes: true });
    const mdFiles = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => path.join(skillsPath, entry.name));

    log.debug({ skillsPath, count: mdFiles.length }, 'Loading skill files');

    for (const filePath of mdFiles) {
      try {
        const loaded = await loadSkillFile(filePath);
        skills.set(loaded.definition.name, loaded);
      } catch (err) {
        log.warn({ err, filePath }, 'Failed to load skill file');
      }
    }

    log.info({ count: skills.size }, 'Skills loaded');
  } catch (err) {
    // Directory doesn't exist - that's okay, return empty map
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.warn({ skillsPath }, 'Skills directory does not exist');
      return skills;
    }
    throw err;
  }

  return skills;
}

/**
 * Get a skill by name.
 */
export function getSkill(skills: Map<string, LoadedSkill>, name: string): LoadedSkill | undefined {
  return skills.get(name);
}

/**
 * List all available skill names.
 */
export function listSkills(skills: Map<string, LoadedSkill>): string[] {
  return Array.from(skills.keys());
}

/**
 * Get skill descriptions for LLM context.
 */
export function getSkillDescriptions(skills: Map<string, LoadedSkill>): string {
  const descriptions: string[] = [];

  for (const [name, loaded] of skills) {
    descriptions.push(
      `- ${name}: ${loaded.definition.description}`
    );
  }

  return descriptions.join('\n');
}