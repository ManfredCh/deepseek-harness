/**
 * Keep repository skill descriptions inside the model-facing catalog budget.
 *
 * `dsh-tool-skill` renders each description with `catalogDescriptionMaxLength`
 * (default 500) and hard-truncates anything longer with an ellipsis. That
 * truncation happens at render time against an intact source file, so it is
 * invisible in review while removing exactly the trigger clause the model
 * needs to select the skill. This gate moves the failure to the source.
 * @module scripts/verify-skill-descriptions
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Model-facing per-description limit in `dsh-tool-skill`'s
 * `DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH`. A description longer than this is
 * truncated before the model sees it.
 */
export const CATALOG_DESCRIPTION_LIMIT = 500

/**
 * Headroom every description must leave below the render limit. A description
 * that exactly fits at 500 is one edit away from silent truncation; requiring
 * margin keeps the trigger clause intact across ordinary rewording.
 */
export const REQUIRED_HEADROOM = 50

/**
 * Ceiling for the summed length of every repository skill description. The
 * rendered catalog is paid on every request, and `dsh-tool-skill` has no
 * aggregate limit, so unbounded growth degrades selection without any signal.
 * Keep this well below the sum of the per-description limits.
 */
export const TOTAL_DESCRIPTION_BUDGET = 4500

/** The clause that tells the model when to reach for a skill. */
const TRIGGER_PATTERN = /\bUse (?:when|before|for|to)\b/

/** A description excluded from model selection states its boundary instead. */
const ANTI_TRIGGER_PATTERN = /\bDo not use\b/

/**
 * Match any repository skill name as a whole word, so a cross reference is
 * detected whatever the naming scheme. A cross reference is only useful to the
 * model when the description also states a boundary, otherwise two
 * descriptions simply claim the same work.
 * @param names - Repository skill directory names.
 * @returns A global regular expression matching any of those names.
 */
function crossReferencePattern(names: readonly string[]): RegExp {
  const escaped = names.map(name => name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'g')
}

/** Boundary language that lets a cross reference disambiguate rather than duplicate. */
const BOUNDARY_PATTERN = /\bDo not use\b|\binstead\b|\bseparately\b|\brather than\b/

/**
 * Share of a description's distinct words that two descriptions have in common.
 * Well-separated skills that merely share repository vocabulary stay low; two
 * descriptions claiming one task climb quickly.
 */
const OVERLAP_LIMIT = 0.5

/**
 * Words too common across descriptions to indicate that two skills overlap.
 * Removing them keeps the overlap signal about claimed work, not repository
 * vocabulary that every description legitimately shares.
 */
const OVERLAP_STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'before', 'by', 'change', 'changes',
  'code', 'deepseek', 'do', 'documentation', 'for', 'from', 'harness', 'in', 'into', 'is',
  'it', 'its', 'md', 'not', 'of', 'on', 'or', 'pr', 'prs', 'repo', 'repository', 's', 'skill',
  'skills', 'that', 'the', 'their', 'them', 'then', 'these', 'this', 'to', 'use', 'used',
  'when', 'which', 'with', 'without', 'work', 'working', 'your',
])

/** Distinct lowercased words in a description, minus vocabulary every description shares. */
function distinctiveWords(description: string): Set<string> {
  return new Set(
    description.toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter(word => word.length > 2 && !OVERLAP_STOPWORDS.has(word)),
  )
}

/** Return an object-shaped YAML value, or undefined for every other shape. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse a skill's YAML frontmatter as an object. */
function parseSkillFrontmatter(source: string): Record<string, unknown> {
  const lines = source.split('\n')
  if (lines[0] !== '---') throw new Error('SKILL.md must start with YAML frontmatter')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed')
  const metadata = asRecord(load(lines.slice(1, end).join('\n')))
  if (metadata === undefined) throw new Error('SKILL.md frontmatter must be a YAML object')
  return metadata
}

/** Repository skills: every directory under `.agents/skills` holding a `SKILL.md`. */
export function repositorySkills(root: string): string[] {
  const skillsRoot = resolve(root, '.agents/skills')
  if (!existsSync(skillsRoot)) return []
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort()
}

/**
 * Read one skill's normalized model-facing description.
 * @param root - Repository root containing `.agents/skills`.
 * @param skill - Skill directory name.
 * @returns The whitespace-normalized description, or undefined when absent.
 */
export function readSkillDescription(root: string, skill: string): string | undefined {
  const frontmatter = parseSkillFrontmatter(readFileSync(resolve(root, '.agents/skills', skill, 'SKILL.md'), 'utf8'))
  const description = frontmatter.description
  return typeof description === 'string' ? description.replaceAll(/\s+/g, ' ').trim() : undefined
}

/**
 * Report skill descriptions that cannot survive the model-facing catalog.
 * @param root - Repository root containing `.agents/skills`.
 * @returns Diagnostics for descriptions that truncate, lack a trigger, or exceed the aggregate budget.
 */
export function collectSkillDescriptionViolations(root: string): string[] {
  const violations: string[] = []
  const lengths: {
    skill: string
    length: number
    crossReferences: string[]
    hasBoundary: boolean
    words: Set<string>
  }[] = []
  const skills = repositorySkills(root)
  const crossReferences = crossReferencePattern(skills)

  for (const skill of skills) {
    const path = `.agents/skills/${skill}/SKILL.md`
    let normalized: string | undefined
    try {
      normalized = readSkillDescription(root, skill)
    }
    catch (error) {
      violations.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (normalized === undefined || normalized === '') {
      violations.push(`${path}: description must be a non-empty string`)
      continue
    }

    const allowed = CATALOG_DESCRIPTION_LIMIT - REQUIRED_HEADROOM
    if (normalized.length > allowed) {
      violations.push(
        `${path}: description is ${String(normalized.length)} characters;`
        + ` the model-facing catalog truncates above ${String(CATALOG_DESCRIPTION_LIMIT)},`
        + ` so keep it at or under ${String(allowed)}`,
      )
    }
    if (!TRIGGER_PATTERN.test(normalized) && !ANTI_TRIGGER_PATTERN.test(normalized)) {
      violations.push(`${path}: description must state when to use the skill ("Use when ...")`)
    }

    const referenced = new Set(normalized.match(crossReferences) ?? [])
    referenced.delete(skill)
    lengths.push({
      skill,
      length: normalized.length,
      crossReferences: [...referenced],
      hasBoundary: BOUNDARY_PATTERN.test(normalized),
      words: distinctiveWords(normalized),
    })
  }

  for (const row of lengths) {
    if (row.crossReferences.length === 0 || row.hasBoundary) continue
    for (const reference of row.crossReferences) {
      if (!existsSync(resolve(root, '.agents/skills', reference, 'SKILL.md'))) continue
      violations.push(
        `.agents/skills/${row.skill}/SKILL.md: description names the "${reference}" skill`
        + ' without a boundary; say which of the two owns the task',
      )
    }
  }

  for (const [index, left] of lengths.entries()) {
    for (const right of lengths.slice(index + 1)) {
      if (left.words.size === 0 || right.words.size === 0) continue
      let shared = 0
      for (const word of left.words) if (right.words.has(word)) shared += 1
      const overlap = shared / Math.min(left.words.size, right.words.size)
      if (overlap > OVERLAP_LIMIT) {
        violations.push(
          `.agents/skills: the "${left.skill}" and "${right.skill}" descriptions share`
          + ` ${String(Math.round(overlap * 100))}% of their distinctive words;`
          + ' separate them so the model can tell which one owns a task',
        )
      }
    }
  }

  const total = lengths.reduce((sum, row) => sum + row.length, 0)
  if (total > TOTAL_DESCRIPTION_BUDGET) {
    violations.push(
      `.agents/skills: descriptions total ${String(total)} characters,`
      + ` over the ${String(TOTAL_DESCRIPTION_BUDGET)}-character catalog budget;`
      + ' condense existing descriptions instead of adding more',
    )
  }

  return violations
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const skills = repositorySkills(ROOT)
  const violations = collectSkillDescriptionViolations(ROOT)
  if (violations.length > 0) {
    process.stderr.write('verify-skill-descriptions: violations found:\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }

  const total = skills.reduce((sum, skill) => sum + (readSkillDescription(ROOT, skill)?.length ?? 0), 0)
  process.stdout.write(
    `verify-skill-descriptions: ${String(skills.length)} description(s) within`
    + ` ${String(CATALOG_DESCRIPTION_LIMIT - REQUIRED_HEADROOM)} characters;`
    + ` ${String(total)}/${String(TOTAL_DESCRIPTION_BUDGET)} characters of catalog budget used.\n`,
  )
}
