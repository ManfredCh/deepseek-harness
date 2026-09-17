import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CATALOG_DESCRIPTION_LIMIT,
  REQUIRED_HEADROOM,
  TOTAL_DESCRIPTION_BUDGET,
  collectSkillDescriptionViolations,
  repositorySkills,
} from './verify-skill-descriptions.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skill-descriptions-'))
  roots.push(root)
  return root
}

function writeSkill(root: string, name: string, description: string, extra = ''): void {
  const directory = join(root, '.agents/skills', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\n\nBody.\n`,
  )
}

describe('skill description catalog-budget gate', () => {
  it('accepts a description with a trigger clause inside the limit', () => {
    const root = fixtureRoot()
    writeSkill(root, 'demo', 'Do a focused thing. Use when the task needs that thing.')

    expect(collectSkillDescriptionViolations(root)).toEqual([])
  })

  it('accepts an anti-trigger description that states its boundary instead of a trigger', () => {
    const root = fixtureRoot()
    writeSkill(root, 'demo', 'Do a focused thing. Do not use for the neighbouring task.')

    expect(collectSkillDescriptionViolations(root)).toEqual([])
  })

  it('lists every repository skill holding a SKILL.md', () => {
    const root = fixtureRoot()
    writeSkill(root, 'alpha', 'Alpha. Use when alpha.')
    writeSkill(root, 'beta', 'Beta. Use when beta.')
    mkdirSync(join(root, '.agents/skills/empty'), { recursive: true })

    expect(repositorySkills(root)).toEqual(['alpha', 'beta'])
  })

  it('rejects a description that the model-facing catalog would truncate', () => {
    const root = fixtureRoot()
    const allowed = CATALOG_DESCRIPTION_LIMIT - REQUIRED_HEADROOM
    writeSkill(root, 'long', `${'x'.repeat(allowed + 1)}. Use when long.`)

    const violations = collectSkillDescriptionViolations(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('description is')
    expect(violations[0]).toContain(`at or under ${String(allowed)}`)
  })

  it('accepts a description exactly at the allowed limit', () => {
    const root = fixtureRoot()
    const allowed = CATALOG_DESCRIPTION_LIMIT - REQUIRED_HEADROOM
    const trigger = ' Use when long.'
    writeSkill(root, 'long', `${'x'.repeat(allowed - trigger.length)}${trigger}`)

    expect(collectSkillDescriptionViolations(root)).toEqual([])
  })

  it('counts normalized length so collapsed whitespace cannot hide an overrun', () => {
    const root = fixtureRoot()
    const allowed = CATALOG_DESCRIPTION_LIMIT - REQUIRED_HEADROOM
    writeSkill(root, 'padded', `${'x'.repeat(allowed)}\n  ${'y'.repeat(20)}. Use when padded.`)

    expect(collectSkillDescriptionViolations(root).some(v => v.includes('description is'))).toBe(true)
  })

  it('rejects a description with no trigger and no boundary', () => {
    const root = fixtureRoot()
    writeSkill(root, 'vague', 'Handles assorted repository concerns.')

    const violations = collectSkillDescriptionViolations(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('must state when to use the skill')
  })

  it('rejects an empty or non-string description', () => {
    const root = fixtureRoot()
    const directory = join(root, '.agents/skills/blank')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), '---\nname: blank\ndescription: ""\n---\n\nBody.\n')

    expect(collectSkillDescriptionViolations(root).some(v => v.includes('non-empty string'))).toBe(true)
  })

  it('rejects a cross reference that carries no boundary', () => {
    const root = fixtureRoot()
    writeSkill(root, 'owner', 'Own the task. Use when the task appears.')
    writeSkill(root, 'neighbour', 'Also handle the task beside dsh-owner. Use when the task appears.')

    const violations = collectSkillDescriptionViolations(root)
    expect(violations.some(v => v.includes('names the "owner" skill'))).toBe(true)
  })

  it('accepts a cross reference paired with boundary language', () => {
    const root = fixtureRoot()
    writeSkill(root, 'owner', 'Own the task. Use when the task appears.')
    writeSkill(root, 'neighbour', 'Select commands only. Use when selecting commands. Do not use dsh-owner for that.')

    expect(collectSkillDescriptionViolations(root)).toEqual([])
  })

  it('rejects two descriptions that claim the same work', () => {
    const root = fixtureRoot()
    const shared = 'Investigate flaky asynchronous teardown failures across shared host resources and listeners.'
    writeSkill(root, 'first', `${shared} Use when flaky teardown appears.`)
    writeSkill(root, 'second', `${shared} Use when flaky teardown reappears.`)

    const violations = collectSkillDescriptionViolations(root)
    expect(violations.some(v => v.includes('distinctive words'))).toBe(true)
  })

  it('rejects a catalog whose descriptions together exceed the aggregate budget', () => {
    const root = fixtureRoot()
    const each = 400
    const count = Math.floor(TOTAL_DESCRIPTION_BUDGET / each) + 1
    for (let index = 0; index < count; index += 1) {
      const trigger = ` Use when task number ${String(index)} appears.`
      writeSkill(root, `skill-${String(index)}`, `${'z'.repeat(each - trigger.length)}${trigger}`)
    }

    const violations = collectSkillDescriptionViolations(root)
    expect(violations.some(v => v.includes('catalog budget'))).toBe(true)
  })

  it('reports a skill directory whose SKILL.md is missing frontmatter', () => {
    const root = fixtureRoot()
    const directory = join(root, '.agents/skills/broken')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), 'No frontmatter here.\n')

    expect(collectSkillDescriptionViolations(root).some(v => v.includes('must start with YAML frontmatter'))).toBe(true)
  })

  it('passes on the real repository skills', () => {
    expect(collectSkillDescriptionViolations(join(import.meta.dirname, '..'))).toEqual([])
  })
})
