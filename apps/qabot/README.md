# dsh-qabot —— 公司智能问答服务

基于 DeepSeek Harness（进程内嵌入）构建的公司内部智能问答服务，供**员工服务台门户**（NestJS）薄代理调用。

当前完成阶段 0 基线和阶段 1 的首个安全切片：持久化文本/视觉索引、门户签名身份、员工会话资源授权、同会话串行执行和版本化会话 API。工单、知识管理和运营接口仍通过兼容 `/api` 提供，迁移到领域模块后再移除兼容接口。

## 架构

```
门户 App.vue (smart-qa/qa-admin) ──HTTP──→ qabot 服务 (node:http, 端口 3100)
                                              │
                          ┌───────────────────┴───────────────┐
                          │ qabot 引擎（dsh 进程内）             │
                          │  agent-spine + llm-deepseek        │
                          │  kb_search + request_human_handoff │
                          │  ticket (SQLite) + session         │
                          └───────────────────┬───────────────┘
                                              └─→ 飞书通知适配器（转人工卡片）
```

## 运行

前置：仓库已 `pnpm install`；`DEEPSEEK_API_KEY` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 在根 `.env`；`DEEPSEEK_BASE_URL` 由启动命令导出。

```sh
pnpm --filter @deepseek-ai/dsh-qabot run dev:ingest   # 索引 docs/ 知识库
DEEPSEEK_BASE_URL=http://<中转>/v1 pnpm --filter @deepseek-ai/dsh-qabot run dev:serve   # 启动 HTTP 服务
```

环境变量：`QABOT_PORT`（默认 3100）、`QABOT_API_TOKEN`（兼容接口必填）、`QABOT_IDENTITY_SECRET`（门户与 Qabot 共享的身份签名密钥）、`PORTAL_URL`（卡片「进入后台」跳转）、`QABOT_STAFF_OPEN_IDS`（服务人员，逗号分隔）。密钥只从部署环境或未提交的根 `.env` 读取。

门户将 UTF-8 JSON 身份声明编码为 base64url，并对该字符串计算 HMAC-SHA256 签名，令牌格式为 `payload.signature`。请求使用 `Authorization: Bearer <token>`；身份包含 `subjectId`、`employeeId`、`displayName`、`departmentIds`、`roles`、`issuedAt` 和 `expiresAt`。

## Versioned employee API

| 方法/路径 | 说明 |
|---|---|
| `POST /v1/conversations` | 创建会话；员工身份取自签名令牌 |
| `GET /v1/conversations` | 当前员工的会话列表 |
| `GET /v1/conversations/:id/messages` | 当前员工的会话消息 |
| `POST /v1/conversations/:id/messages` | 在会话中提问 `{ message }` |
| `DELETE /v1/conversations/:id` | 归档当前员工的会话 |
| `POST /v1/conversations/:id/rating` | 会话内提交 `{ ticketId, rating, version }` |
| `GET /v1/agent/tickets` | 客服所属服务组的工单列表；SystemAdmin 可查看全部 |
| `GET /v1/agent/tickets/:id` | 有权访问的工单详情和人工回复 |
| `POST /v1/agent/tickets/:id/accept` | 使用签名身份中的 `employeeId` 接单，提交 `{ version }` |
| `POST /v1/agent/tickets/:id/reply` | 提交 `{ message, version }`，追加公开回复并进入 `waiting_employee` |
| `GET /v1/system/audit` | SystemAdmin 查询特权操作审计记录 |

## HTTP 接口

| 方法/路径 | 说明 |
|---|---|
| `POST /api/chat` | `{ userId, message }` → `{ text, ticketId, handoffRequested, serviceMs }` |
| `GET /api/tickets` | 工单列表，`?status=&limit=` |
| `GET /api/tickets/:id` | 工单详情 + 会话转录 |
| `POST /api/tickets/:id/accept` | 接单 `{ assignee }` → in_service |
| `POST /api/tickets/:id/reply` | 人工回复 `{ message }`（经飞书发给员工） |
| `POST /api/tickets/:id/close` | 关闭 `{ satisfaction? }` |
| `GET /api/kb` | 知识库条目 |
| `POST /api/kb/ingest` | 手工录入 `{ title, content }` |
| `DELETE /api/kb/:source` | 删除知识库条目 |
| `GET /api/stats` | 服务统计 |

## 鉴权

- 所有环境**强制** `QABOT_API_TOKEN`，缺失时拒绝启动（防止内网机器绕过门户直接调 3100）。
- 除静态测试页 `/`、`/chat.html` 与 `/api/health` 外，所有 `/api/*` 请求必须携带请求头 `X-Qabot-Token: <令牌>`，否则返回 401。
- 令牌值：`start-qabot.bat` 内置默认值，根 `.env` 写入同值（`loadEnv` 会读取）。
- **门户 smart-qa 薄代理转发时必须在每个请求上带同值的 `X-Qabot-Token`**，否则门户所有请求 401。测试页 `/` 首次打开会弹窗输入令牌（存 localStorage）。
- 想轮换令牌：改 `start-qabot.bat` 与 `.env` 里的同值，并同步门户侧配置。

## 目录

```
src/
  bin.ts            入口（console | feishu | serve | ingest）
  compose.ts        dsh 组合（persona、模型、持久化、插件）
  runner.ts         Qabot 引擎：每用户一会话，问答→工单，转录
  http/server.ts    HTTP 服务（node:http 零依赖）
  feishu/           WS 网关（bot 入口已降级）+ 通知适配器（转人工卡片）
  kb/               FTS5 知识库（node:sqlite，中文 trigram + LIKE 兜底）
  ticket/           工单 SQLite 存储
  migrations/       PostgreSQL 与 MySQL 单调迁移脚本
  plugins/          kb_search / request_human_handoff 工具
docs/               样例知识库（替换为公司真实文档）
data/               （gitignore）运行时数据 + staff.json 服务人员名单
```

## 部署（内网服务）

### 启动（手动）
```sh
# 一键启动脚本（Windows）——含中转地址等环境变量
apps/qabot/start-qabot.bat

# 或手动：
cd d:\deepseek_q&a
DEEPSEEK_BASE_URL=http://<中转>/v1 node --import tsx/esm apps/qabot/src/bin.ts serve
```

### 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_BASE_URL` | 必填 | 中转网关（禁止写 .env，必须启动时导出） |
| `QABOT_PORT` | 3100 | 服务端口 |
| `QABOT_HOST` | 0.0.0.0 | 监听地址（内网访问用 0.0.0.0） |
| `QABOT_SYNC_INTERVAL_MINUTES` | 30 | 知识库定时同步（0 关闭） |
| `QABOT_API_TOKEN` | 必填 | 鉴权头 X-Qabot-Token；所有环境强制（缺失拒绝启动）。start-qabot.bat 内置默认值，根 .env 已写入同值 |
| `QABOT_IDENTITY_SECRET` | 必填 | 校验门户短时签名身份令牌；不得提交到仓库 |
| `QABOT_MAX_BODY_BYTES` | 1048576 | HTTP 请求体上限 |
| `QABOT_MAX_MESSAGE_LENGTH` | 8000 | 单条员工消息字符上限 |
| `QABOT_IDLE_CONVERSATION_MS` | 3600000 | 纯智能工单无活动后自动完成的时限 |
| `QABOT_IDLE_SWEEP_MS` | 60000 | 空闲纯智能工单检查间隔 |
| `QABOT_OUTBOX_INTERVAL_MS` | 1000 | 外部通知队列轮询间隔，最小 100 毫秒 |
| `QABOT_DATABASE_URL` | 无 | PostgreSQL 连接 URL，数据库名使用 `hr_system` |
| `QABOT_DATABASE_BACKEND` | sqlite | 业务数据后端；可选 `sqlite`、`mysql` 或 `postgres` |
| `QABOT_MYSQL_URL` | 无 | MySQL 连接 URL；MySQL 后端必填 |

工单后台统一显示待处理、待接单、处理中和已完成。纯智能工单处于待处理，仅主管可见；超过空闲时限后自动进入已完成。转人工工单进入待接单，接单后进入处理中，结束服务后进入已完成。客服转接必须选择目标服务组及该组具体人员。

工单响应包含单调递增的 `version`。客服修改接口必须回传最近读取的版本；版本过期或状态不允许时返回 HTTP 409，前端应刷新工单后再决定是否重试。

应用服务依赖 Conversation、Ticket、Audit 和 Outbox Repository 接口；接口允许同步或异步实现，调用方统一 `await`，因此 SQLite、MySQL 和 PostgreSQL 可以替换而不修改业务规则。Qabot 引擎、HTTP 服务和模型转人工工具共享同一组 Repository。数据库启动时先执行对应后端的待处理迁移，再组合业务组件。

PostgreSQL 部署配置示例：

```env
QABOT_DATABASE_BACKEND=postgres
QABOT_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/hr_system
```

缺少连接 URL 时 PostgreSQL 模式拒绝启动，不会回落到 SQLite。

PostgreSQL Outbox 使用 `FOR UPDATE SKIP LOCKED` 领取消息，并记录 worker 与五分钟租约；多个进程不会同时领取同一条任务，进程退出遗留的领取会在租约到期后恢复。

仅在明确指定的 PostgreSQL 数据库执行迁移：

```sh
QABOT_DATABASE_URL=postgres://user:password@host:5432/qabot pnpm --filter @deepseek-ai/dsh-qabot run db:migrate:postgres
```

迁移命令缺少 `QABOT_DATABASE_URL` 时拒绝执行。连接字符串只放部署环境，不提交到仓库。

实际部署数据库为 MySQL `hr_system`。MySQL 迁移按 `migrations/mysql/NNN_name.sql` 连续编号，并通过 `GET_LOCK` 串行执行。MySQL DDL 会隐式提交，迁移器因此在执行前写入 `dirty=1`；执行中断后会拒绝继续迁移，要求先人工确认数据库状态，避免把部分建表误记为完成。

```sh
pnpm --filter @deepseek-ai/dsh-qabot run db:migrate:mysql
```

MySQL 后端提供完整的 Conversation、Ticket、Audit 和 Outbox Repository。部署配置为 `QABOT_DATABASE_BACKEND=mysql` 与 `QABOT_MYSQL_URL`；启动会自动执行待处理迁移。真实集成测试只读取 `QABOT_TEST_MYSQL_URL`，不得将其长期指向生产数据库。

飞书转人工通知和人工公开回复先写入 `data/outbox.db`，HTTP 请求不等待飞书。后台任务按指数退避重试，最多八次；相同幂等键只入队一次。工单状态已变化的旧转人工通知会直接完成而不发送，避免转派后再通知旧队列。

满意度在员工门户聊天界面完成，不通过飞书卡片。工单处于 `resolved` 或 `closed` 时，所属员工可提交一次 1-5 分评价；请求必须携带工单最新 `version`，重复评价或版本冲突返回 HTTP 409。工单不存储服务评论字段。
| `PORTAL_URL` | http://localhost:5173 | 转人工卡片「进入后台」跳转地址 |
| `VISION_EMBED_MODEL` | 未启用 | 视觉向量模型；推荐 `qwen3-vl-embedding`，配置后同步飞书文档图片并启用文搜图 |
| `VISION_EMBED_API_KEY` | `EMBED_API_KEY` | 百炼 API Key；视觉模型使用 DashScope 多模态接口，不走 OpenAI `/embeddings` |
| `VISION_EMBED_BASE_URL` | `https://dashscope.aliyuncs.com/api/v1` | DashScope 多模态 API 地址 |
| `VISION_EMBED_DIMENSION` | 1024 | 视觉向量维度；修改后已有视觉向量会自动增量重算 |

### 日志
- 控制台 + `apps/qabot/data/qabot.log`（带时间戳/级别）
- 运行数据都在 `apps/qabot/data/`：`kb.db`/`tickets.db`/`conversations.db`/`kb-sources.json`/`staff.json`

### 开机自启（Windows 任务计划程序）
```powershell
# 用管理员 PowerShell，注册开机自启任务（登录时运行，需换成本机实际路径）
schtasks /Create /TN "qabot-service" /TR "cmd /c D:\deepseek_q&a\apps\qabot\start-qabot.bat" /SC ONLOGON /RL HIGHEST /F
# 手动运行一次测试
schtasks /Run /TN "qabot-service"
# 删除任务
schtasks /Delete /TN "qabot-service" /F
```

### 内网访问
服务监听 `0.0.0.0:3100`，局域网内通过 `http://<本机IP>:3100/` 访问测试页。
注意：Windows 防火墙需放行 3100 端口（`netsh advfirewall firewall add rule name="qabot" dir=in action=allow protocol=TCP localport=3100`）。

## 已知事项

- **中转余额**：`192.168.10.61:3000` 间歇 `Insufficient Balance` → 偶发 STREAM_CLOSED，需充值。
- **空回复自动重试**：中继异常导致回合空回复时自动重试一次，仍空则返回「模型服务暂时异常，请稍后重试」，不再让用户看到空白（重试的系统提示在会话转录中隐藏）。
- **向量索引增量持久化**：向量表随 `kb.db` 持久保留，不会每次启动重建。文本和视觉向量分别使用 `text`/`vision` 类型；内容、模型或维度变化时只更新失效记录。飞书图片原始数据保存在 `vision_assets`，因此视觉模型切换后不需要依赖旧下载链接。
- **视觉检索**：设置 `VISION_EMBED_MODEL=qwen3-vl-embedding` 后，飞书文档图片会下载并生成独立视觉向量。员工文本查询使用同一模型生成查询向量，与文本检索结果合并。需要飞书 `drive:drive:readonly` 下载权限。
- **飞书权限**：应用需开通 `im:message:send_as_bot`（发消息）等权限，否则发送会降级为仅记日志。
- 工具注册必须 `defineTool`（裸 register 的 parameters 不转 JSON Schema，中继拒收）。
