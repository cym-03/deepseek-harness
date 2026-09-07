import { describe, expect, it } from 'vitest'
import { parentKnowledgeSourceKey } from '../src/database/mysql-knowledge-projection.ts'

describe('MySQL knowledge source ownership', () => {
  it.each([
    ['wiki:policy', 'wiki:policy'],
    ['wiki:policy:img:3', 'wiki:policy'],
    ['wiki:policy:image', 'wiki:policy'],
    ['wiki:policy:vision:board:board-1', 'wiki:policy'],
    ['wiki:policy:board-text:board-1', 'wiki:policy'],
  ])('assigns %s to %s', (source, expected) => {
    expect(parentKnowledgeSourceKey(source)).toBe(expected)
  })
})
