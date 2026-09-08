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
      expect(store.listAll().map(item => item.sessionId)).toEqual(['older', 'newer'])
    } finally {
      now.mockRestore()
      store.dispose()
    }
  })

  it('does not reuse a titled conversation when a stale message count is zero', () => {
    const store = new ConversationStore(':memory:')
    try {
      store.create('employee', 'answered')
      store.touch('employee', 'answered', 0, '在职证明在哪里申请？')

      expect(store.findEmpty('employee')).toBeUndefined()

      store.create('employee', 'empty')
      expect(store.findEmpty('employee')?.sessionId).toBe('empty')
    } finally {
      store.dispose()
    }
  })
})
