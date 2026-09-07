/** Builds and persists the employee-visible conversation timeline. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConversationMessageProjection, ConversationMessageRepository, TicketRepository } from '../domain/repositories.ts'
import type { KbMediaRef, KbStore } from '../kb/store.ts'
import type { Qabot } from '../runner.ts'

export const EMPLOYEE_TICKET_MESSAGE_PREFIX = '【员工消息】'

export interface ConversationTimelineMessage {
  role: 'user' | 'assistant' | 'human' | 'system'
  text: string
  createdAt: number
  images?: KbMediaRef[]
}

export interface ConversationTimeline {
  events: readonly SessionEvent[]
  messages: ConversationTimelineMessage[]
  latestMessageId: number
}

function sessionEventProjection(
  sessionId: string,
  event: SessionEvent,
  images: readonly KbMediaRef[],
): ConversationMessageProjection | undefined {
  if (event.type === 'user/message') {
    const text = event.data.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    if (text.startsWith('【人工接管期间员工消息】')) return undefined
    if (text === '' || text.startsWith('【人工客服回复】') || text.startsWith('【系统重试】')) return undefined
    return {
      sessionId,
      sourceType: 'dsh_event',
      sourceId: String(event.seq),
      sourceOrder: event.seq,
      role: 'user',
      text,
      createdAt: event.time,
    }
  }
  if (event.type !== 'assistant/message') return undefined
  const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  if (text === '') return undefined
  return {
    sessionId,
    sourceType: 'dsh_event',
    sourceId: String(event.seq),
    sourceOrder: event.seq,
    role: 'assistant',
    text,
    createdAt: event.time,
    ...(images.length === 0 ? {} : { images: [...images] }),
  }
}

/**
 * Loads one timeline, adds every durable source message to the business projection, and reads the projection back.
 * @param sessionId - Conversation session identifier.
 * @param qabot - DSH conversation runtime.
 * @param tickets - Ticket and public-reply repository.
 * @param kb - Knowledge store that owns message image references.
 * @param repository - Optional business-message projection; absent backends return the source timeline directly.
 * @returns Source events and employee-visible messages in chronological order.
 */
export async function loadConversationTimeline(
  sessionId: string,
  qabot: Qabot,
  tickets: TicketRepository,
  kb: KbStore,
  repository?: ConversationMessageRepository,
): Promise<ConversationTimeline> {
  const events = await qabot.transcript(sessionId)
  const mediaByOrder = kb.conversationMedia(sessionId)
  const projected: ConversationMessageProjection[] = []
  for (const event of events) {
    const message = sessionEventProjection(sessionId, event, mediaByOrder.get(event.seq) ?? [])
    if (message !== undefined) projected.push(message)
  }
  for (const reply of await tickets.repliesBySession(sessionId)) {
    const employeeMessage = reply.message.startsWith(EMPLOYEE_TICKET_MESSAGE_PREFIX)
    projected.push({
      sessionId,
      sourceType: 'ticket_reply',
      sourceId: String(reply.id),
      sourceOrder: reply.id,
      role: employeeMessage ? 'user' : 'human',
      text: employeeMessage ? reply.message.slice(EMPLOYEE_TICKET_MESSAGE_PREFIX.length) : reply.message,
      createdAt: reply.createdAt,
    })
  }
  projected.sort((left, right) => left.createdAt - right.createdAt || left.sourceOrder - right.sourceOrder)
  if (repository === undefined) {
    return {
      events,
      messages: projected.map(({ role, text, createdAt, images }) => ({
        role,
        text,
        createdAt,
        ...(images === undefined ? {} : { images }),
      })),
      latestMessageId: 0,
    }
  }
  await repository.upsert(projected)
  const stored = await repository.list(sessionId)
  return {
    events,
    messages: stored.map(({ role, text, createdAt, images }) => ({
      role,
      text,
      createdAt,
      ...(images === undefined ? {} : { images }),
    })),
    latestMessageId: stored.reduce((latest, message) => Math.max(latest, message.id), 0),
  }
}
