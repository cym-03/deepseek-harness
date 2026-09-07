import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { loadConversationTimeline } from '../src/conversation/timeline.ts'
import type {
  ConversationMessage,
  ConversationMessageProjection,
  ConversationMessageRepository,
  TicketRepository,
} from '../src/domain/repositories.ts'
import type { KbStore } from '../src/kb/store.ts'
import type { Qabot } from '../src/runner.ts'

class MemoryMessageRepository implements ConversationMessageRepository {
  private readonly messages = new Map<string, ConversationMessage>()
  private readonly reads = new Map<string, number>()
  private nextId = 1

  upsert(messages: readonly ConversationMessageProjection[]): void {
    for (const message of messages) {
      const key = `${message.sessionId}:${message.sourceType}:${message.sourceId}`
      const existing = this.messages.get(key)
      this.messages.set(key, { id: existing?.id ?? this.nextId++, ...message })
    }
  }

  list(sessionId: string): ConversationMessage[] {
    return [...this.messages.values()]
      .filter(message => message.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt || left.sourceOrder - right.sourceOrder)
  }

  count(sessionId?: string): number {
    return sessionId === undefined ? this.messages.size : this.list(sessionId).length
  }

  markRead(sessionId: string, readerKey: string, throughMessageId: number): void {
    const previous = this.reads.get(`${sessionId}:${readerKey}`) ?? 0
    this.reads.set(`${sessionId}:${readerKey}`, Math.max(previous, throughMessageId))
  }

  unreadCounts(
    sessionIds: readonly string[],
    readerKey: string,
    roles: readonly ConversationMessage['role'][],
  ): Map<string, number> {
    return new Map(sessionIds.map((sessionId) => {
      const lastRead = this.reads.get(`${sessionId}:${readerKey}`) ?? 0
      const count = this.list(sessionId).filter(message => message.id > lastRead && roles.includes(message.role)).length
      return [sessionId, count]
    }))
  }
}

describe('conversation timeline projection', () => {
  it('keeps database messages available when a later DSH read is empty', async () => {
    const events = [
      { type: 'user/message', seq: 1, time: 100, data: { content: [{ type: 'text', text: '年假怎么申请' }] } },
      { type: 'assistant/message', seq: 2, time: 200,
        data: { message: { content: [{ type: 'text', text: '请在飞书提交申请' }] } } },
    ] as unknown as SessionEvent[]
    const transcript = vi.fn<() => Promise<readonly SessionEvent[]>>()
      .mockResolvedValueOnce(events)
      .mockResolvedValueOnce([])
    const qabot = { transcript } as unknown as Qabot
    const tickets = { repliesBySession: vi.fn().mockResolvedValue([]) } as unknown as TicketRepository
    const kb = { conversationMedia: vi.fn().mockReturnValue(new Map()) } as unknown as KbStore
    const repository = new MemoryMessageRepository()

    expect((await loadConversationTimeline('session-1', qabot, tickets, kb, repository)).messages).toHaveLength(2)
    expect((await loadConversationTimeline('session-1', qabot, tickets, kb, repository)).messages).toEqual([
      expect.objectContaining({ role: 'user', text: '年假怎么申请' }),
      expect.objectContaining({ role: 'assistant', text: '请在飞书提交申请' }),
    ])
    expect(repository.count('session-1')).toBe(2)
  })

  it('does not mark a message that arrived after the returned timeline as read', async () => {
    const repository = new MemoryMessageRepository()
    repository.upsert([{ sessionId: 'session-1', sourceType: 'dsh_event', sourceId: '1', sourceOrder: 1,
      role: 'assistant', text: '已展示回复', createdAt: 100 }])
    const returnedMessageId = repository.list('session-1')[0]?.id ?? 0
    repository.upsert([{ sessionId: 'session-1', sourceType: 'ticket_reply', sourceId: '2', sourceOrder: 2,
      role: 'human', text: '稍后到达的人工回复', createdAt: 200 }])
    repository.markRead('session-1', 'employee:test', returnedMessageId)

    expect(repository.unreadCounts(['session-1'], 'employee:test', ['assistant', 'human']))
      .toEqual(new Map([['session-1', 1]]))
  })

  it('shows an employee handoff message once through its durable ticket reply', async () => {
    const events = [{
      type: 'user/message',
      seq: 7,
      time: 100,
      data: { content: [{ type: 'text', text: '【人工接管期间员工消息】请帮我补办门禁卡' }] },
    }] as unknown as SessionEvent[]
    const qabot = { transcript: vi.fn().mockResolvedValue(events) } as unknown as Qabot
    const tickets = { repliesBySession: vi.fn().mockResolvedValue([{
      id: 11,
      message: '【员工消息】请帮我补办门禁卡',
      createdAt: 100,
    }]) } as unknown as TicketRepository
    const kb = { conversationMedia: vi.fn().mockReturnValue(new Map()) } as unknown as KbStore
    const repository = new MemoryMessageRepository()

    const timeline = await loadConversationTimeline('session-1', qabot, tickets, kb, repository)

    expect(timeline.messages).toEqual([
      expect.objectContaining({ role: 'user', text: '请帮我补办门禁卡' }),
    ])
    expect(repository.count('session-1')).toBe(1)
  })
})
