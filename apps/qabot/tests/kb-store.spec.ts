import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KbStore } from '../src/kb/store.ts'

const originalEmbedModel = process.env.EMBED_MODEL
const originalEmbedBaseUrl = process.env.EMBED_BASE_URL
const originalEmbedApiKey = process.env.EMBED_API_KEY
const originalVisionModel = process.env.VISION_EMBED_MODEL
const originalVisionBaseUrl = process.env.VISION_EMBED_BASE_URL
const originalVisionApiKey = process.env.VISION_EMBED_API_KEY
const originalVisionDimension = process.env.VISION_EMBED_DIMENSION
const originalVisionMaxPerSync = process.env.VISION_EMBED_MAX_PER_SYNC
const tempDirs: string[] = []

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qabot-kb-'))
  tempDirs.push(dir)
  return join(dir, 'kb.db')
}

function restoreEnv(): void {
  if (originalEmbedModel === undefined) delete process.env.EMBED_MODEL
  else process.env.EMBED_MODEL = originalEmbedModel
  if (originalEmbedBaseUrl === undefined) delete process.env.EMBED_BASE_URL
  else process.env.EMBED_BASE_URL = originalEmbedBaseUrl
  if (originalEmbedApiKey === undefined) delete process.env.EMBED_API_KEY
  else process.env.EMBED_API_KEY = originalEmbedApiKey
  if (originalVisionModel === undefined) delete process.env.VISION_EMBED_MODEL
  else process.env.VISION_EMBED_MODEL = originalVisionModel
  if (originalVisionBaseUrl === undefined) delete process.env.VISION_EMBED_BASE_URL
  else process.env.VISION_EMBED_BASE_URL = originalVisionBaseUrl
  if (originalVisionApiKey === undefined) delete process.env.VISION_EMBED_API_KEY
  else process.env.VISION_EMBED_API_KEY = originalVisionApiKey
  if (originalVisionDimension === undefined) delete process.env.VISION_EMBED_DIMENSION
  else process.env.VISION_EMBED_DIMENSION = originalVisionDimension
  if (originalVisionMaxPerSync === undefined) delete process.env.VISION_EMBED_MAX_PER_SYNC
  else process.env.VISION_EMBED_MAX_PER_SYNC = originalVisionMaxPerSync
}

afterEach(() => {
  vi.unstubAllGlobals()
  restoreEnv()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('KbStore embedding persistence', () => {
  it('keeps staged document changes out of retrieval until publication', async () => {
    const store = new KbStore(tempDb())
    store.upsertChunks('policy', ['旧版报销流程'], '员工制度')

    const staged = store.stageChunks('policy', ['新版报销流程'], '员工制度')
    expect(staged.changed).toBe(true)
    expect(store.list()).toEqual([{
      source: 'policy',
      title: '员工制度',
      chunks: 1,
      url: null,
      publicationStatus: 'online',
      effectiveAt: null,
      expiresAt: null,
    }])
    expect(store.pendingVersions()).toHaveLength(1)
    const beforePublication = await store.search('新版报销流程')

    expect(store.publishVersion(staged.versionId!, 'reviewer-1')).toBe(true)
    expect(store.pendingVersions()).toHaveLength(0)
    const afterPublication = await store.search('新版报销流程')
    store.dispose()
    expect(beforePublication).toMatch(/^未在知识库中找到/)
    expect(afterPublication).toContain('新版报销流程')
  })

  it('excludes offline, not-yet-effective, and expired documents from every retrieval path', async () => {
    delete process.env.EMBED_MODEL
    const store = new KbStore(tempDb())
    store.upsertChunks('online-policy', ['在线制度唯一内容'], '在线制度')
    store.upsertChunks('offline-policy', ['下架制度唯一内容'], '下架制度')
    store.upsertChunks('future-policy', ['未来制度唯一内容'], '未来制度', undefined, {
      effectiveAt: Date.now() + 60_000,
    })
    store.upsertChunks('expired-policy', ['过期制度唯一内容'], '过期制度', undefined, {
      expiresAt: Date.now() - 1,
    })
    expect(store.setPublication('offline-policy', false)).toBe(true)

    expect(await store.search('在线制度唯一内容')).toContain('在线制度唯一内容')
    expect(await store.search('下架制度唯一内容')).toMatch(/^未在知识库中找到/)
    expect(await store.search('未来制度唯一内容')).toMatch(/^未在知识库中找到/)
    expect(await store.search('过期制度唯一内容')).toMatch(/^未在知识库中找到/)
    expect(store.list().map(item => [item.source, item.publicationStatus])).toEqual([
      ['online-policy', 'online'],
      ['offline-policy', 'offline'],
      ['future-policy', 'scheduled'],
      ['expired-policy', 'offline'],
    ])
    store.dispose()
  })

  it('publishes a reviewed version with a validity window and keeps vectors reusable after reactivation', async () => {
    delete process.env.EMBED_MODEL
    const store = new KbStore(tempDb())
    store.upsertChunks('policy', ['旧版制度'], '员工制度')
    expect(await store.embedMissing()).toBe(1)
    expect(store.setPublication('policy', false)).toBe(true)
    expect(await store.search('旧版制度')).toMatch(/^未在知识库中找到/)
    expect(store.setPublication('policy', true)).toBe(true)
    expect(await store.embedMissing()).toBe(0)

    const staged = store.stageChunks('policy', ['新版制度'], '员工制度')
    const effectiveAt = Date.now() + 60_000
    const expiresAt = effectiveAt + 60_000
    expect(store.publishVersion(staged.versionId!, 'reviewer-1', { effectiveAt, expiresAt })).toBe(true)
    expect(store.list()[0]).toMatchObject({ publicationStatus: 'scheduled', effectiveAt, expiresAt })
    expect(await store.search('新版制度')).toMatch(/^未在知识库中找到/)
    store.dispose()
  })

  it('migrates the single-kind legacy table to a composite key', async () => {
    delete process.env.EMBED_MODEL
    const path = tempDb()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        hash TEXT
      );
      INSERT INTO docs (title, source, content) VALUES ('制度', 'legacy', '报销需要审批');
      CREATE TABLE embeddings (
        doc_id INTEGER PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
        vector TEXT NOT NULL
      );
      INSERT INTO embeddings (doc_id, vector) VALUES (1, '{}');
    `)
    legacy.close()

    const store = new KbStore(path)
    expect(await store.embedMissing()).toBe(1)
    store.dispose()

    const migrated = new DatabaseSync(path)
    const primaryKey = migrated.prepare('PRAGMA table_info(embeddings)').all() as unknown as Array<{
      name: string
      pk: number
    }>
    expect(primaryKey.filter(column => column.pk > 0).map(column => column.name)).toEqual(['doc_id', 'vector_kind'])
    migrated.close()
  })

  it('keeps local vectors across restarts', async () => {
    delete process.env.EMBED_MODEL
    const path = tempDb()
    const first = new KbStore(path)
    first.upsertChunks('policy', ['报销需要审批', '年假按制度申请'], '员工制度')
    expect(await first.embedMissing()).toBe(2)
    first.dispose()

    const reopened = new KbStore(path)
    expect(await reopened.embedMissing()).toBe(0)
    reopened.upsertChunks('policy', ['报销需要主管审批', '年假按制度申请'], '员工制度')
    // 本地 TF-IDF 的 IDF 依赖全库，所以语料变化时需要整体更新。
    expect(await reopened.embedMissing()).toBe(2)
    reopened.dispose()

    const db = new DatabaseSync(path)
    const primaryKey = db.prepare('PRAGMA table_info(embeddings)').all() as unknown as Array<{
      name: string
      pk: number
    }>
    expect(primaryKey.filter(column => column.pk > 0).map(column => column.name)).toEqual(['doc_id', 'vector_kind'])
    db.close()
  })

  it('only embeds changed content with a remote model', async () => {
    process.env.EMBED_BASE_URL = 'https://embedding.test/v1'
    process.env.EMBED_API_KEY = 'test-key'
    process.env.EMBED_MODEL = 'model-a'
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
      const request = JSON.parse(init.body) as { input: string[] }
      return new Response(JSON.stringify({
        data: request.input.map((_, index) => ({ embedding: [index + 1, 0] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const path = tempDb()
    const first = new KbStore(path)
    first.upsertChunks('policy', ['报销需要审批', '年假按制度申请'], '员工制度')
    expect(await first.embedMissing()).toBe(2)
    first.dispose()

    const reopened = new KbStore(path)
    expect(await reopened.embedMissing()).toBe(0)
    reopened.upsertChunks('policy', ['报销需要主管审批', '年假按制度申请'], '员工制度')
    expect(await reopened.embedMissing()).toBe(1)
    reopened.dispose()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates stored vectors when the remote model changes', async () => {
    process.env.EMBED_BASE_URL = 'https://embedding.test/v1'
    process.env.EMBED_API_KEY = 'test-key'
    process.env.EMBED_MODEL = 'model-a'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [1, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const path = tempDb()
    const first = new KbStore(path)
    first.upsertChunks('policy', ['报销需要审批'], '员工制度')
    expect(await first.embedMissing()).toBe(1)
    first.dispose()

    process.env.EMBED_MODEL = 'model-b'
    const changedModel = new KbStore(path)
    expect(await changedModel.embedMissing()).toBe(1)
    changedModel.dispose()
  })

  it('persists visual vectors and retrieves an image with a text query', async () => {
    delete process.env.EMBED_MODEL
    process.env.VISION_EMBED_MODEL = 'qwen3-vl-embedding'
    process.env.VISION_EMBED_BASE_URL = 'https://vision.test/api/v1'
    process.env.VISION_EMBED_API_KEY = 'vision-key'
    process.env.VISION_EMBED_DIMENSION = '1024'
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
      const request = JSON.parse(init.body) as {
        input: { contents: Array<{ image?: string; text?: string }> }
      }
      const content = request.input.contents[0]
      expect(content?.image !== undefined || content?.text !== undefined).toBe(true)
      return new Response(JSON.stringify({
        output: { embeddings: [{ embedding: [1, 0] }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const path = tempDb()
    const first = new KbStore(path)
    first.upsertVisionAsset({
      source: 'wiki:policy:vision:image-1',
      title: '报销流程图',
      description: '财务报销审批流程图',
      url: 'https://example.feishu.cn/wiki/policy',
      mime: 'image/png',
      image: Buffer.from('image-one'),
    })
    expect(await first.embedVisionMissing()).toBe(1)
    first.dispose()

    const reopened = new KbStore(path)
    expect(await reopened.embedVisionMissing()).toBe(0)
    expect(await reopened.search('查看报销流程图')).toContain('报销流程图')
    const media = await reopened.findVisionMedia('查看报销流程图')
    expect(media).toEqual([{
      id: expect.any(Number),
      title: '报销流程图',
      sourceUrl: 'https://example.feishu.cn/wiki/policy',
    }])
    expect(await reopened.findVisionMedia('查看报销流程图')).toEqual(media)
    expect(reopened.setPublication('wiki:policy:vision:image-1', false)).toBe(true)
    expect(await reopened.search('查看报销流程图')).toMatch(/^未在知识库中找到/)
    expect(await reopened.findVisionMedia('查看报销流程图')).toEqual([])
    expect(reopened.setPublication('wiki:policy:vision:image-1', true)).toBe(true)
    expect(await reopened.embedVisionMissing()).toBe(0)
    expect(await reopened.findVisionMedia('查看报销流程图')).toEqual(media)
    reopened.setConversationMedia('session-1', 12, media)
    expect(reopened.conversationMedia('session-1').get(12)).toEqual(media)
    expect(reopened.visionStatus()).toEqual({
      configured: true,
      model: expect.stringContaining('qwen3-vl-embedding'),
      assets: 1,
      embeddings: 1,
      cachedQueries: 1,
      returnedImages: 1,
    })
    expect(reopened.visionAsset(media[0]!.id)).toEqual({
      mime: 'image/png',
      image: Buffer.from('image-one'),
    })
    reopened.dispose()
    // 一次图片嵌入、一次问题嵌入；相同问题的后续检索全部复用持久缓存。
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caps new visual embeddings per synchronization run', async () => {
    process.env.VISION_EMBED_MODEL = 'qwen3-vl-embedding'
    process.env.VISION_EMBED_BASE_URL = 'https://vision.test/api/v1'
    process.env.VISION_EMBED_API_KEY = 'vision-key'
    process.env.VISION_EMBED_MAX_PER_SYNC = '1'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: { embeddings: [{ embedding: [1, 0] }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const store = new KbStore(tempDb())
    for (const token of ['image-1', 'image-2']) {
      store.upsertVisionAsset({
        source: `wiki:policy:vision:${token}`,
        title: token,
        description: token,
        mime: 'image/png',
        image: Buffer.from(token),
      })
    }

    expect(await store.embedVisionMissing()).toBe(1)
    expect(await store.embedVisionMissing()).toBe(1)
    expect(await store.embedVisionMissing()).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    store.dispose()
  })
})
