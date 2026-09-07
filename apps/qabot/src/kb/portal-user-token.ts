/** Retrieves a short-lived Feishu user token from the portal-owned credential broker. */
export async function fetchSubmitterFeishuToken(employeeId: string): Promise<string> {
  const base = (process.env.QABOT_PORTAL_INTERNAL_URL ?? 'http://127.0.0.1:3000/api/internal/qabot').replace(/\/+$/, '')
  const serviceToken = process.env.QABOT_API_TOKEN ?? ''
  if (serviceToken === '') throw new Error('未配置 QABOT_API_TOKEN，无法读取提交人的飞书授权')
  const response = await fetch(`${base}/feishu-user-token/${encodeURIComponent(employeeId)}`, {
    headers: { 'x-qabot-token': serviceToken },
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => ({})) as { accessToken?: string; message?: string; error?: string }
  if (!response.ok || body.accessToken === undefined || body.accessToken === '') {
    throw new Error(`提交人的飞书授权不可用：${body.message ?? body.error ?? `HTTP ${response.status}`}`)
  }
  return body.accessToken
}
