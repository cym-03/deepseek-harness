import { afterEach, describe, expect, it, vi } from 'vitest'
import { storeVisionAssets, type ImageHint } from '../src/kb/image-ocr.ts'
import type { KbStore } from '../src/kb/store.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function kbStub(existingSources: ReadonlySet<string> = new Set()): KbStore {
  return {
    hasVisionAssetSource: vi.fn((source: string) => existingSources.has(source)),
    upsertVisionAsset: vi.fn(),
    pruneVisionAssets: vi.fn(),
  } as unknown as KbStore
}

const credentials = { appId: 'app-id', appSecret: 'app-secret' }
const hints: ImageHint[] = [
  { token: 'image-1', caption: '', section: '第一章' },
  { token: 'image-2', caption: '', section: '第二章' },
]

describe('Feishu vision asset download', () => {
  it('stops the document download after the first permission denial', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { tmp_download_urls: [] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const kb = kbStub()

    expect(await storeVisionAssets(kb, credentials, 'wiki:policy', hints, '员工手册')).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(kb.upsertVisionAsset).not.toHaveBeenCalled()
  })

  it('does not download a token whose image is already durable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(Buffer.from('new-image'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const kb = kbStub(new Set(['wiki:policy:vision:image-1']))

    expect(await storeVisionAssets(kb, credentials, 'wiki:policy', hints, '员工手册')).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(kb.upsertVisionAsset).toHaveBeenCalledTimes(1)
  })

  it('uses a temporary URL when direct media download returns 403', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { tmp_download_urls: ['https://tmp.example/image'] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('temporary-image'), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)
    const kb = kbStub()

    expect(await storeVisionAssets(kb, credentials, 'wiki:policy', [hints[0]!], '员工手册')).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(kb.upsertVisionAsset).toHaveBeenCalledWith(expect.objectContaining({ mime: 'image/jpeg', image: Buffer.from('temporary-image') }))
  })
})
