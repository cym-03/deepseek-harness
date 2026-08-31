import { describe, expect, it } from 'vitest'
import { KeyedSerialExecutor } from '../src/application/keyed-serial.ts'
import { signPortalIdentity, verifyPortalIdentity, type PortalIdentity } from '../src/security/identity.ts'

const NOW = 1_800_000_000_000
const identity: PortalIdentity = {
  subjectId: 'portal-user-1',
  employeeId: 'employee-1',
  displayName: '测试员工',
  departmentIds: ['it'],
  roles: ['Employee'],
  issuedAt: NOW - 1_000,
  expiresAt: NOW + 60_000,
}

describe('portal identity', () => {
  it('accepts a valid signed identity', () => {
    const token = signPortalIdentity(identity, 'test-secret')
    expect(verifyPortalIdentity(token, 'test-secret', NOW)).toEqual(identity)
  })

  it('rejects tampering, expiration, and unknown roles', () => {
    const token = signPortalIdentity(identity, 'test-secret')
    expect(() => verifyPortalIdentity(`${token}x`, 'test-secret', NOW)).toThrow('IDENTITY_TOKEN_INVALID')
    expect(() => verifyPortalIdentity(token, 'test-secret', identity.expiresAt)).toThrow('IDENTITY_TOKEN_INVALID')
    const invalid = signPortalIdentity({ ...identity, roles: ['Owner' as never] }, 'test-secret')
    expect(() => verifyPortalIdentity(invalid, 'test-secret', NOW)).toThrow('IDENTITY_TOKEN_INVALID')
  })
})

describe('keyed serialization', () => {
  it('serializes one key while allowing independent keys to progress', async () => {
    const executor = new KeyedSerialExecutor()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = executor.run('conversation-a', async () => {
      events.push('a1-start')
      await firstBlocked
      events.push('a1-end')
    })
    const second = executor.run('conversation-a', async () => { events.push('a2') })
    await executor.run('conversation-b', async () => { events.push('b') })
    expect(events).toEqual(['a1-start', 'b'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['a1-start', 'b', 'a1-end', 'a2'])
  })
})
