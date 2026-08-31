/** Persistence interfaces used by Qabot application services. */
import type { AuditRecord } from '../audit/store.ts'
import type { Conversation } from '../conversation/store.ts'
import type { OutboxEventType, OutboxMessage } from '../integration/outbox.ts'
import type { Ticket, TicketStatus } from '../ticket/store.ts'
import type { KbMediaRef } from '../kb/store.ts'

export type Awaitable<T> = T | Promise<T>

export interface ConversationRepository {
  create(userKey: string, sessionId: string): Awaitable<void>
  touch(userKey: string, sessionId: string, messageCount: number, firstQuestion?: string): Awaitable<void>
  findEmpty(userKey: string): Awaitable<Conversation | undefined>
  list(userKey: string): Awaitable<Conversation[]>
  listAll(): Awaitable<Conversation[]>
  ownerOf(sessionId: string): Awaitable<string | undefined>
  archive(userKey: string, sessionId: string): Awaitable<boolean>
}

export type ConversationMessageRole = 'user' | 'assistant' | 'human' | 'system'

export interface ConversationMessageProjection {
  sessionId: string
  sourceType: 'dsh_event' | 'ticket_reply' | 'system'
  sourceId: string
  sourceOrder: number
  role: ConversationMessageRole
  text: string
  createdAt: number
  images?: KbMediaRef[]
}

export interface ConversationMessage extends ConversationMessageProjection {
  id: number
}

export interface ConversationMessageRepository {
  upsert(messages: readonly ConversationMessageProjection[]): Awaitable<void>
  list(sessionId: string): Awaitable<ConversationMessage[]>
  count(sessionId?: string): Awaitable<number>
  /**
   * Advances one reader through a message included in the returned timeline without moving backward.
   * @param sessionId - Conversation whose visible timeline was opened.
   * @param readerKey - Role-scoped employee identifier such as `employee:<id>` or `agent:<id>`.
   * @param throughMessageId - Greatest projected message id included in that timeline response.
   */
  markRead(sessionId: string, readerKey: string, throughMessageId: number): Awaitable<void>
  /**
   * Counts messages after each reader position, restricted to roles that represent incoming messages.
   * @param sessionIds - Conversations visible to the reader.
   * @param readerKey - Role-scoped employee identifier.
   * @param roles - Incoming message roles for the employee or service-desk view.
   * @returns Unread counts keyed by session; sessions without unread messages are absent.
   */
  unreadCounts(
    sessionIds: readonly string[],
    readerKey: string,
    roles: readonly ConversationMessageRole[],
  ): Awaitable<Map<string, number>>
}

export interface TicketRepository {
  get(id: number): Awaitable<Ticket | undefined>
  replies(ticketId: number): Awaitable<Array<{ id: number; message: string; createdAt: number }>>
  addReply(ticketId: number, message: string): Awaitable<number>
  repliesBySession(sessionId: string): Awaitable<Array<{ id: number; message: string; createdAt: number }>>
  listByGroup(group: string, limit?: number): Awaitable<Ticket[]>
  forSession(sessionId: string): Awaitable<Ticket | undefined>
  ensureOpen(input: { sessionId: string; userKey: string; question: string }): Awaitable<Ticket>
  openService(sessionId: string): Awaitable<void>
  closeService(sessionId: string): Awaitable<void>
  markHandoff(sessionId: string, reason: string, group?: string): Awaitable<void>
  assign(ticketId: number, assignee: string, department: string | null): Awaitable<void>
  accept(ticketId: number, assignee: string, expectedVersion?: number): Awaitable<boolean>
  reply(ticketId: number, message: string, expectedVersion: number): Awaitable<number | undefined>
  transfer(ticketId: number, toGroup: string, note: string | null, expectedVersion?: number): Awaitable<boolean>
  resolve(sessionId: string): Awaitable<void>
  closeStaleOpen(cutoff: number): Awaitable<number>
  close(ticketId: number, satisfaction: number | null, expectedVersion?: number): Awaitable<boolean>
  rate(ticketId: number, satisfaction: number, expectedVersion?: number): Awaitable<boolean>
  findPendingRating(userKey: string): Awaitable<Ticket | undefined>
  list(filter?: { status?: TicketStatus; assignee?: string; userKey?: string; limit?: number }): Awaitable<Ticket[]>
  stats(since?: number): Awaitable<{
    count: number
    handoffCount: number
    resolvedCount: number
    avgServiceMs: number | null
    avgSatisfaction: number | null
  }>
}

export interface AuditRepository {
  append(input: Omit<AuditRecord, 'id' | 'createdAt'>): Awaitable<AuditRecord>
  list(limit?: number): Awaitable<AuditRecord[]>
}

export interface OutboxRepository {
  enqueue(idempotencyKey: string, type: OutboxEventType, payload: unknown): Awaitable<boolean>
  pending(limit?: number, now?: number): Awaitable<OutboxMessage[]>
  complete(id: number): Awaitable<void>
  retry(id: number, error: string, delayMs: number, maxAttempts: number): Awaitable<void>
  count(status: 'pending' | 'completed' | 'failed'): Awaitable<number>
}
