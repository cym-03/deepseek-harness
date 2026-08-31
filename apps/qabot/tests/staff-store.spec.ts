import { afterEach, describe, expect, it } from 'vitest'
import { StaffStore } from '../src/staff/store.ts'

describe('StaffStore notifications', () => {
  const stores: StaffStore[] = []

  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose()
  })

  it('notifies every active member in the selected service group', () => {
    const store = new StaffStore(':memory:')
    stores.push(store)
    store.upsert({ openId: 'ou_it_1', group: 'IT', name: 'IT一号' })
    store.upsert({ openId: 'ou_it_2', group: 'IT', name: 'IT二号' })
    store.upsert({ openId: 'ou_hr', group: '人事', name: '人事专员' })

    expect(store.notifyTargets('IT')).toEqual(['ou_it_1', 'ou_it_2'])
  })

  it('does not notify another group when the selected group has no member', () => {
    const store = new StaffStore(':memory:')
    stores.push(store)
    store.upsert({ openId: 'ou_default', group: 'default', name: '综合专员' })

    expect(store.notifyTargets('default')).toEqual(['ou_default'])
    expect(store.notifyTargets('财务')).toEqual([])
  })
})
