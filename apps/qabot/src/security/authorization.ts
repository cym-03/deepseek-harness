import type { Ticket } from '../ticket/store.ts'
import { hasRole, type PortalIdentity } from './identity.ts'

/** Returns whether an identity may use service-desk routes. */
export function isServiceDeskUser(identity: PortalIdentity): boolean {
  return hasRole(identity, ['Agent', 'DepartmentAdmin', 'SystemAdmin'])
}

/** Returns whether a service-desk identity may access a ticket's assigned group. */
export function canAccessTicket(identity: PortalIdentity, ticket: Ticket): boolean {
  if (hasRole(identity, ['SystemAdmin'])) return true
  if (!isServiceDeskUser(identity) || ticket.department === null) return false
  return identity.departmentIds.includes(ticket.department)
}

/** Returns whether an operator may mutate an online knowledge source in a maintenance group. */
export function canManageKnowledgeSource(identity: PortalIdentity, group: string): boolean {
  if (hasRole(identity, ['SystemAdmin'])) return true
  const maintenanceGroups = identity.departmentIds.map(item => item === 'default' ? '其他' : item)
  return maintenanceGroups.includes(group)
}
