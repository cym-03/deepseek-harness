import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPersistedQabotSession, resolveQabotSessionCwd } from '../src/runner.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Qabot session location', () => {
  it.each([
    ['--D-project--', false],
    ['--D-project-apps-qabot--', true],
  ])('discovers persisted sessions under the configured repository root', (cwdDirectory, appWorkspace) => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'qabot-session-root-'))
    temporaryRoots.push(repositoryRoot)
    const sessionId = 'user-employee-1-session-1'
    const sessionDirectory = join(repositoryRoot, 'apps', 'qabot', 'data', 'sessions', cwdDirectory, sessionId)
    mkdirSync(sessionDirectory, { recursive: true })
    writeFileSync(join(sessionDirectory, 'session.jsonl.zstd'), 'fixture')

    expect(hasPersistedQabotSession(repositoryRoot, sessionId)).toBe(true)
    expect(resolveQabotSessionCwd(repositoryRoot, sessionId)).toBe(
      appWorkspace ? join(repositoryRoot, 'apps', 'qabot') : repositoryRoot,
    )
  })

  it('does not derive persistence from the process working directory', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'qabot-session-root-'))
    temporaryRoots.push(repositoryRoot)

    expect(hasPersistedQabotSession(repositoryRoot, 'missing-session')).toBe(false)
    expect(resolveQabotSessionCwd(repositoryRoot, 'missing-session')).toBe(repositoryRoot)
  })
})
