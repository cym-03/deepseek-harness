import { afterEach, describe, expect, it } from 'vitest'
import { StaffStore } from '../src/staff/store.ts'

describe('StaffStore assignment', () => {
  const stores: StaffStore[] = []

  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose()
  })

  it('distributes tickets within the selected service group', () => {
    const store = new StaffStore(':memory:')
    stores.push(store)
    store.upsert({ openId: 'ou_it_1', group: 'IT', name: 'IT一号' })
    store.upsert({ openId: 'ou_it_2', group: 'IT', name: 'IT二号' })
    store.upsert({ openId: 'ou_hr', group: '人事', name: '人事专员' })

    expect(store.assignmentTarget('IT', 2)?.name).toBe('IT一号')
    expect(store.assignmentTarget('IT', 3)?.name).toBe('IT二号')
    expect(store.assignmentTarget('IT', 2, 'IT一号')?.name).toBe('IT二号')
  })

  it('uses general-service staff only for the general-service group', () => {
    const store = new StaffStore(':memory:')
    stores.push(store)
    store.upsert({ openId: 'ou_default', group: 'default', name: '综合专员' })

    expect(store.assignmentTarget('default', 1)?.name).toBe('综合专员')
    expect(store.assignmentTarget('财务', 1)).toBeUndefined()
  })
})
