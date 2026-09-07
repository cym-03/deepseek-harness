import { afterEach, describe, expect, it, vi } from 'vitest'
import { feishuContentToken } from '../src/kb/feishu-auth.ts'

afterEach(() => vi.unstubAllGlobals())

describe('Feishu content authorization', () => {
  it('uses the supplied submitter token without requesting a tenant token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(feishuContentToken({ appId: 'app', appSecret: 'secret', accessToken: 'user-token' }))
      .resolves.toBe('user-token')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
