import { describe, expect, it, vi } from 'vitest'
import { OutboxStore, OutboxWorker } from '../src/integration/outbox.ts'

describe('integration outbox', () => {
  it('deduplicates enqueue operations and completes a delivered message', async () => {
    const store = new OutboxStore(':memory:')
    const handler = vi.fn(async () => {})
    try {
      expect(store.enqueue('ticket:1:handoff:2', 'ticket.handoff', { ticketId: 1, ticketVersion: 2 })).toBe(true)
      expect(store.enqueue('ticket:1:handoff:2', 'ticket.handoff', { ticketId: 1, ticketVersion: 2 })).toBe(false)
      const worker = new OutboxWorker(store, { 'ticket.handoff': handler })
      expect(await worker.runOnce()).toBe(1)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(store.count('completed')).toBe(1)
      expect(store.count('pending')).toBe(0)
    } finally {
      store.dispose()
    }
  })

  it('retains a failed delivery for a later retry', async () => {
    const store = new OutboxStore(':memory:')
    try {
      store.enqueue('ticket:2:handoff:1', 'ticket.handoff', { ticketId: 2 })
      const worker = new OutboxWorker(store, { 'ticket.handoff': async () => { throw new Error('temporary failure') } })
      expect(await worker.runOnce()).toBe(0)
      expect(store.count('pending')).toBe(1)
      expect(store.count('completed')).toBe(0)
    } finally {
      store.dispose()
    }
  })

  it('does not overlap worker passes', async () => {
    const store = new OutboxStore(':memory:')
    let release = (): void => { throw new Error('release not initialized') }
    const blocked = new Promise<void>((resolve) => { release = resolve })
    try {
      store.enqueue('ticket:3:handoff:1', 'ticket.handoff', { ticketId: 3 })
      const worker = new OutboxWorker(store, { 'ticket.handoff': async () => blocked })
      const first = worker.runOnce()
      expect(await worker.runOnce()).toBe(0)
      release()
      expect(await first).toBe(1)
    } finally {
      store.dispose()
    }
  })
})
