const API_BASE = 'https://open.feishu.cn/open-apis'

export interface FeishuContentCredentials {
  appId: string
  appSecret: string
  accessToken?: string
}

/** Resolves the caller-supplied user token, or a tenant token for non-source compatibility paths. */
export async function feishuContentToken(credentials: FeishuContentCredentials): Promise<string> {
  if (credentials.accessToken !== undefined && credentials.accessToken !== '') return credentials.accessToken
  const response = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
  })
  const body = await response.json() as { code?: number; tenant_access_token?: string; msg?: string }
  if (body.code !== 0 || body.tenant_access_token === undefined) {
    throw new Error(`获取 tenant_access_token 失败 code=${body.code} msg=${body.msg}`)
  }
  return body.tenant_access_token
}
