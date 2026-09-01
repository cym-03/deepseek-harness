/**
 * 飞书通知适配器：实现 QabotNotificationAdapter。
 * - sendToUser：把人工回复/系统消息发给员工（open_id 收文本）
 * - notifyHandoff：转人工时给服务人员发交互卡片，含「进入后台」按钮
 * 服务人员名单：data/staff.json（{ "default": ["ou_xxx"] }）或环境变量 QABOT_STAFF_OPEN_IDS（逗号分隔）。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as lark from '@larksuiteoapi/node-sdk'
import type { Ticket } from '../ticket/store.ts'
import type { QabotNotificationAdapter } from '../http/server.ts'

export interface FeishuNotifyOptions {
  appId: string
  appSecret: string
  /** 门户地址（卡片「进入后台」跳转用）。默认 http://localhost:5173 */
  portalUrl?: string
  /** 动态获取服务人员 open_id（按身份组）。缺省读 staff.json/env。 */
  getStaff?: (group?: string) => string[] | Promise<string[]>
}

export class FeishuNotificationAdapter implements QabotNotificationAdapter {
  private readonly client: lark.Client
  private readonly portalUrl: string

  constructor(private readonly options: FeishuNotifyOptions) {
    this.client = new lark.Client({ appId: options.appId, appSecret: options.appSecret })
    this.portalUrl = options.portalUrl ?? process.env.PORTAL_URL ?? 'http://localhost:5173'
  }

  /** 当前服务人员 open_id 列表（按身份组，组空回退 default）。 */
  private async staffOpenIds(group?: string): Promise<string[]> {
    if (this.options.getStaff !== undefined) return this.options.getStaff(group)
    return loadStaffOpenIds(group)
  }

  /** 给员工发一条文本消息（open_id）。飞书失败只记日志，不阻断业务。 */
  async sendToUser(openId: string, text: string): Promise<void> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
      if (resp.code !== 0) {
        console.error(`[feishu] 给用户发消息失败 code=${resp.code} msg=${resp.msg}`)
      }
    } catch (error) {
      console.error('[feishu] 给用户发消息异常:', error instanceof Error ? error.message : error)
    }
  }

  /** 转人工：给对应身份组的服务人员发交互卡片（进入后台按钮）。飞书失败只记日志。 */
  async notifyHandoff(ticket: Ticket): Promise<void> {
    const group = ticket.department ?? 'default'
    const staff = await this.staffOpenIds(group)
    if (staff.length === 0) {
      console.warn(`[feishu] 身份组「${group}」无服务人员，且无 default 兜底，跳过通知`)
      return
    }
    const backUrl = `${this.portalUrl}?module=qa-admin&ticket=${ticket.id}`
    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🛎️ 智能问答转人工通知' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**工单 #${ticket.id}**（状态：${ticket.status} · 归属组：${group}）\n`
              + `**员工问题**：${ticket.question.slice(0, 80)}\n`
              + `**转人工原因**：${ticket.handoffReason ?? '-'}\n`
              + `**发起时间**：${new Date(ticket.createdAt).toLocaleString('zh-CN')}`,
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '进入问答后台处理' },
              type: 'primary',
              url: backUrl,
            },
          ],
        },
      ],
    }
    for (const openId of staff) {
      try {
        const resp = await this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        })
        if (resp.code !== 0) {
          console.error(`[feishu] 转人工通知失败 code=${resp.code} msg=${resp.msg}`)
        }
      } catch (error) {
        console.error('[feishu] 转人工通知异常:', error instanceof Error ? error.message : error)
      }
    }
    console.log(`[feishu] 已通知 ${staff.length} 位服务人员（工单 #${ticket.id}）`)
  }
}

/** 读服务人员名单（按组）：env 只支持 default；否则 data/staff.json（按组）。 */
function loadStaffOpenIds(group?: string): string[] {
  const fromEnv = process.env.QABOT_STAFF_OPEN_IDS
  if (fromEnv !== undefined && fromEnv.trim() !== '' && (group === undefined || group === 'default')) {
    return fromEnv.split(',').map(s => s.trim()).filter(s => s !== '')
  }
  const file = join(process.cwd(), 'data', 'staff.json')
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const list = parsed[group ?? 'default']
      if (Array.isArray(list)) {
        return [...new Set(list.filter((x): x is string => typeof x === 'string'))]
      }
      if (group !== undefined) {
        const fallback = parsed.default
        if (Array.isArray(fallback)) {
          return [...new Set(fallback.filter((x): x is string => typeof x === 'string'))]
        }
      }
      return []
    } catch {
      return []
    }
  }
  return []
}
