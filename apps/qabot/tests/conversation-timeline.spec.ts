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
})
