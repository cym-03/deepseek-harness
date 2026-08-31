/**
 * kb_search 工具：让 agent 在回答公司问题前检索知识库。
 * 插件在组合时挂载（ctx.plugin），注册工具到 ctx.tools。
 * 必须用 defineTool（而非裸 register），它会把 parameters DSL 编译成
 * 完整 JSON Schema（type: object + properties），中继/OpenAI 兼容接口才会接受。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KbStore } from '../kb/store.ts'

export const name = 'qabot-kb'
export const inject = ['tools']

export interface Config {
  /** 知识库 SQLite 文件路径。 */
  dbPath: string
}

export function apply(ctx: Context, config: Config): void {
  const store = new KbStore(config.dbPath)
  ctx.tools.register(defineTool({
    name: 'kb_search',
    description:
      '检索公司知识库（制度、流程、FAQ、产品文档）。回答任何与公司内部事务相关的问题前，必须先调用本工具获取依据；'
      + '如果检索结果不相关或为空，如实说明并建议转人工。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '要检索的关键词或完整问题，中文短语更佳',
      },
      limit: {
        type: 'number',
        description: '最多返回的文档片段数，默认 5',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, _exec) {
      return store.search(args.query, args.limit ?? 5)
    },
  }))
}
