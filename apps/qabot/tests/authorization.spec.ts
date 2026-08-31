import { describe, expect, it } from 'vitest'
import { AuditStore } from '../src/audit/store.ts'
import { canAccessTicket, isServiceDeskUser } from '../src/security/authorization.ts'
import type { PortalIdentity } from '../src/security/identity.ts'
import type { Ticket } from '../src/ticket/store.ts'

function identity(roles: PortalIdentity['roles'], departmentIds: string[]): PortalIdentity {
  return {
    subjectId: 'subject-1', employeeId: 'employee-1', displayName: '员工',
    departmentIds, roles, issuedAt: 1, expiresAt: 2,
  }
}

const ticket = { id: 1, department: 'it' } as Ticket

describe('ticket authorization', () => {
  it('limits agents and department administrators to their groups', () => {
    expect(isServiceDeskUser(identity(['Employee'], ['it']))).toBe(false)
    expect(canAccessTicket(identity(['Agent'], ['it']), ticket)).toBe(true)
    expect(canAccessTicket(identity(['DepartmentAdmin'], ['hr']), ticket)).toBe(false)
  })

  it('allows system administrators to access every group', () => {
    expect(canAccessTicket(identity(['SystemAdmin'], []), ticket)).toBe(true)
  })

  it('does not expose unassigned tickets to ordinary agents', () => {
    expect(canAccessTicket(identity(['Agent'], ['it']), { ...ticket, department: null })).toBe(false)
  })
})

describe('audit store', () => {
  it('persists privileged actions in reverse chronological order', () => {
    const store = new AuditStore(':memory:')
    try {
      store.append({ actorId: 'agent-1', action: 'ticket.accept', resourceType: 'ticket', resourceId: '7', detail: null })
      store.append({ actorId: 'agent-1', action: 'ticket.reply', resourceType: 'ticket', resourceId: '7', detail: null })
      expect(store.list().map(record => record.action)).toEqual(['ticket.reply', 'ticket.accept'])
    } finally {
      store.dispose()
    }
  })
})
