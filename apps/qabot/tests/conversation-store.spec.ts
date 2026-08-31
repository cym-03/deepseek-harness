import { describe, expect, it, vi } from 'vitest'
import { ConversationStore } from '../src/conversation/store.ts'

describe('ConversationStore activity ordering', () => {
  it('moves a touched conversation to the front', () => {
    const store = new ConversationStore(':memory:')
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(100)
      store.create('employee', 'older')
      now.mockReturnValue(200)
      store.create('employee', 'newer')
      expect(store.list('employee').map(item => item.sessionId)).toEqual(['newer', 'older'])

      now.mockReturnValue(300)
      store.touch('employee', 'older', 3, 'updated')
      expect(store.list('employee').map(item => item.sessionId)).toEqual(['older', 'newer'])
      expect(store.list('employee')[0]).toMatchObject({ lastMessageAt: 300, messageCount: 3 })
    } finally {
      now.mockRestore()
      store.dispose()
    }
  })
})
