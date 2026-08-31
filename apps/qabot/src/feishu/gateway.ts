/**
 * 飞书网关：WebSocket 长连接接收事件（免公网回调），路由消息到 Qabot 引擎。
 * 单聊直接响应；群聊仅当 @机器人 时响应。
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { Qabot } from '../runner.ts'

export interface FeishuGatewayOptions {
  appId: string
  appSecret: string
}

/** 从飞书消息 content JSON 中解析出纯文本（去掉 @提及 标记）。 */
export function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return (parsed.text ?? '').replace(/<at\s+user_id="[^"]*"[^>]*>\s*<\/at>/g, '').trim()
  } catch {
    return content
  }
}

interface P2MessageReceive {
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: 'p2p' | 'group' | string
    content?: string
    create_time?: string
  }
  sender?: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string }
    sender_type?: string
  }
}

export class FeishuGateway {
  private readonly client: lark.Client
  private readonly ws: lark.WSClient
  private readonly perUser = new Map<string, Promise<unknown>>()

  constructor(
    options: FeishuGatewayOptions,
    private readonly qabot: Qabot,
  ) {
    this.client = new lark.Client({ appId: options.appId, appSecret: options.appSecret })
    this.ws = new lark.WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    })
  }

  /** 启动长连接监听。连接成功表示事件订阅可用。 */
  async start(): Promise<void> {
    console.log('[feishu] 正在连接长连接…')
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => this.handleMessage(data as P2MessageReceive),
    })
    await this.ws.start({ eventDispatcher: dispatcher })
    console.log('[feishu] 长连接已建立，等待消息')
  }

  /** 给用户发文本消息。 */
  async sendText(openId: string, text: string): Promise<void> {
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    if (resp.code !== 0) {
      console.error(`[feishu] 发送消息失败 code=${resp.code} msg=${resp.msg}`)
    }
  }

  /** 在群聊里回复指定消息（会@对方）。 */
  async reply(openId: string, messageId: string, text: string): Promise<void> {
    const resp = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
    if (resp.code !== 0) {
      console.error(`[feishu] 回复消息失败 code=${resp.code} msg=${resp.msg}`)
      await this.sendText(openId, text).catch(() => {})
    }
  }

  private async handleMessage(data: P2MessageReceive): Promise<void> {
    const message = data.message
    const sender = data.sender
    const openId = sender?.sender_id?.open_id
    const messageId = message?.message_id
    const chatType = message?.chat_type
    const rawContent = message?.content ?? ''

    if (openId === undefined || messageId === undefined) return
    if (chatType !== 'p2p' && chatType !== 'group') return

    const text = extractText(rawContent)
    if (text === '') return

    // 群聊只在 @机器人 时响应。
    if (chatType === 'group' && !rawContent.includes('<at')) return

    // 每用户串行处理，避免同一会话并发交叠。
    const chain = (this.perUser.get(openId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.processMessage(openId, messageId, chatType, text))
    this.perUser.set(openId, chain)
    await chain
  }

  private async processMessage(
    openId: string,
    messageId: string,
    chatType: string,
    text: string,
  ): Promise<void> {
    if (chatType === 'group') {
      await this.reply(openId, messageId, '🤔 正在思考…')
    } else {
      await this.sendText(openId, '🤔 正在思考…')
    }

    try {
      const outcome = await this.qabot.ask(openId, text)
      let answer = outcome.text
      if (answer === '') answer = '模型服务暂时异常，请稍后重试'
      if (outcome.handoffRequested) {
        answer += '\n\n（已为您转接人工客服，稍后会有服务人员联系您）'
      }
      if (chatType === 'group') {
        await this.reply(openId, messageId, answer)
      } else {
        await this.sendText(openId, answer)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[feishu] 处理消息失败:', message)
      await this.sendText(openId, `抱歉，处理您的消息时出错了：${message.slice(0, 200)}`).catch(() => {})
    }
  }
}
