/**
 * qabot 启动引导。
 *
 * 必须先读取根 .env，再动态导入 bin.ts。模型 provider 会在模块初始化阶段
 * 读取 API Key；直接运行 bin.ts 会让 Windows 会话里残留的旧环境变量抢先生效。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
loadEnv(join(root, '.env'), { override: true })

await import('./bin.ts')
