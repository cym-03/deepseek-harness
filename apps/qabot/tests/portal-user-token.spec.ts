import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSubmitterFeishuToken } from '../src/kb/portal-user-token.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.QABOT_API_TOKEN
  delete process.env.QABOT_PORTAL_INTERNAL_URL
})

describe('portal Feishu user-token broker', () => {
  it('requests the source submitter token without exposing the service credential in the URL', async () => {
    process.env.QABOT_API_TOKEN = 'service-secret'
    process.env.QABOT_PORTAL_INTERNAL_URL = 'http://portal.local/api/internal/qabot/'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: 'user-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSubmitterFeishuToken('ou/a')).resolves.toBe('user-token')
    expect(fetchMock).toHaveBeenCalledWith('http://portal.local/api/internal/qabot/feishu-user-token/ou%2Fa',
      expect.objectContaining({ headers: { 'x-qabot-token': 'service-secret' } }))
  })

  it('surfaces a submitter re-login instruction without falling back to tenant credentials', async () => {
    process.env.QABOT_API_TOKEN = 'service-secret'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '请由提交人重新登录门户' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(fetchSubmitterFeishuToken('missing')).rejects.toThrow('请由提交人重新登录门户')
  })
})
