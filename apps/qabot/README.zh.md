# dsh-qabot —— 公司智能问答服务

[English](README.md) | 中文

基于 DeepSeek Harness（进程内嵌入）构建的公司内部智能问答服务，供**员工服务台门户**（NestJS）薄代理调用。

当前基线包含持久化文本/视觉索引、门户签名身份、员工会话资源授权、同会话串行执行、版本化会话 API，以及以 MySQL 为权威配置的在线知识源管理。工单和运营接口仍通过兼容 `/api` 提供，迁移到领域模块后再移除兼容接口。

## 架构

```
Portal App.vue (smart-qa/qa-admin) ──HTTP──→ Qabot service (node:http, port 3100)
                                              │
                          ┌───────────────────┴───────────────┐
                          │ In-process dsh Qabot engine        │
                          │  agent-spine + llm-deepseek        │
                          │  kb_search + request_human_handoff │
                          │  MySQL repositories + session log  │
                          └───────────────────┬───────────────┘
                                              └─→ Feishu notification adapter
```

## 运行

前置：仓库已 `pnpm install`；`DEEPSEEK_API_KEY` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 在根 `.env`；`DEEPSEEK_BASE_URL` 由启动命令导出。

```sh
pnpm --filter @deepseek-ai/dsh-qabot run dev:ingest   # Index the docs/ knowledge base
DEEPSEEK_BASE_URL=http://<relay>/v1 pnpm --filter @deepseek-ai/dsh-qabot run dev:serve   # Start HTTP
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
| `GET /v1/events` | 通过 SSE 推送按签名身份过滤的会话与工单变更事件 |
| `GET /v1/agent/tickets` | 客服所属服务组的工单列表；SystemAdmin 可查看全部 |
| `GET /v1/agent/tickets/:id` | 有权访问的工单详情和人工回复 |
| `POST /v1/agent/tickets/:id/accept` | 使用签名身份中的 `employeeId` 接单，提交 `{ version }` |
| `POST /v1/agent/tickets/:id/reply` | 提交 `{ message, version }`，追加公开回复并进入 `waiting_employee` |
| `GET /v1/knowledge/sources` | 列出活跃在线知识源及其同步健康状态 |
| `POST /v1/knowledge/sources` | 新增 `{ title, url, group }` 并触发首次同步 |
| `PATCH /v1/knowledge/sources/:id` | 修改知识源标题或维护分组 |
| `POST /v1/knowledge/sources/:id/sync` | 立即同步单个知识源 |
| `DELETE /v1/knowledge/sources/:id` | 软移除知识源并停止同步和召回 |
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
| `GET /api/stats` | 服务统计 |

## 鉴权

- 所有环境**强制** `QABOT_API_TOKEN`，缺失时拒绝启动（防止内网机器绕过门户直接调 3100）。
- 除静态测试页 `/`、`/chat.html` 与 `/api/health` 外，所有 `/api/*` 请求必须携带请求头 `X-Qabot-Token: <令牌>`，否则返回 401。
- 令牌只由部署环境提供，启动脚本不内置默认值。
- **门户 smart-qa 薄代理转发时必须在每个请求上带同值的 `X-Qabot-Token`**，否则门户所有请求 401。测试页 `/` 首次打开会弹窗输入令牌（存 localStorage）。
- 想轮换令牌：改 `start-qabot.bat` 与 `.env` 里的同值，并同步门户侧配置。

## 目录

```
src/
  bin.ts            Entry point: console | feishu | serve | ingest
  compose.ts        dsh composition: persona, model, persistence, plugins
  runner.ts         Per-employee Qabot sessions, Q&A, ticket creation, transcript
  http/server.ts    Dependency-free node:http server
  feishu/           Notification adapter and legacy bot gateway
  kb/               SQLite FTS5 and hybrid text/visual retrieval
  ticket/           SQLite development ticket store
  migrations/       Monotonic PostgreSQL and MySQL migrations
  plugins/          kb_search and request_human_handoff tools
docs/               Sample knowledge documents
data/               Gitignored runtime data and service-agent configuration
```

## 部署（内网服务）

### 启动（手动）
```sh
# Windows launcher with deployment environment
apps/qabot/start-qabot.bat

# Or start directly:
cd d:\deepseek_q&a
DEEPSEEK_BASE_URL=http://<relay>/v1 node --import tsx/esm apps/qabot/src/bin.ts serve
```

### 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_BASE_URL` | 必填 | 中转网关（禁止写 .env，必须启动时导出） |
| `QABOT_PORT` | 3100 | 服务端口 |
| `QABOT_HOST` | 0.0.0.0 | 监听地址（内网访问用 0.0.0.0） |
| `QABOT_SYNC_INTERVAL_MINUTES` | 5 | 知识库定时同步（0 关闭） |
| `QABOT_API_TOKEN` | 必填 | 鉴权头 X-Qabot-Token；所有环境强制（缺失拒绝启动）。start-qabot.bat 内置默认值，根 .env 已写入同值 |
| `QABOT_PORTAL_INTERNAL_URL` | `http://127.0.0.1:3000/api/internal/qabot` | 按提交人身份同步飞书知识时使用的门户凭证代理地址 |
| `QABOT_IDENTITY_SECRET` | 必填 | 校验门户短时签名身份令牌；不得提交到仓库 |
| `QABOT_MAX_BODY_BYTES` | 1048576 | HTTP 请求体上限 |
| `QABOT_MAX_MESSAGE_LENGTH` | 8000 | 单条员工消息字符上限 |
| `QABOT_IDLE_CONVERSATION_MS` | 3600000 | 智能会话和已接单人工会话的空闲完成时限 |
| `QABOT_IDLE_SWEEP_MS` | 60000 | 空闲会话检查间隔 |
| `QABOT_OUTBOX_INTERVAL_MS` | 1000 | 外部通知队列轮询间隔，最小 100 毫秒 |
| `QABOT_DATABASE_URL` | 无 | PostgreSQL 连接 URL，数据库名使用 `hr_system` |
| `QABOT_DATABASE_BACKEND` | sqlite | 业务数据后端；可选 `sqlite`、`mysql` 或 `postgres` |
| `QABOT_MYSQL_URL` | 无 | MySQL 连接 URL；MySQL 后端必填 |

工单后台统一显示待处理、待接单、处理中和已完成。纯智能工单处于待处理且仅主管可见；纯智能会话或已接单人工会话超过空闲时限后自动进入已完成，员工页面立即显示评分控件。尚未接单的转人工工单继续留在所选服务组的共享待接单队列，不因空闲超时关闭，并通知该组全部已启用服务人员；第一位接单人取得工单。后续客服转接仍须选择目标服务组及该组具体人员。

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

MySQL 后端把会话、消息、工单、审计记录、Outbox、服务人员配置、在线知识源配置、内部知识版本、来源图片二进制与向量、查询向量缓存和 DSH 模型原始事件统一保存到 `hr_system`。知识源首次同步成功后立即参与员工问答；后续成功同步会原子替换当前内容，更新失败则继续使用上一次可用内容。`kb.db` 仅作为解析同步内容和计算缺失向量的可重建工作索引，不再是生产知识源注册表或检索权威源。投影只复制已有向量，不会再次请求 embedding；模型检索读取 MySQL 中的活跃来源，并为每个非空员工问题自动合并文本和相关图片召回。只有存在可用图片候选时才生成视觉查询向量，并按规范化问题哈希与模型标识复用。业务日期使用 Asia/Shanghai 时区的 `DATETIME(3)` 字段，运维人员可以直接看到 `年-月-日 时:分:秒.毫秒`；Repository 在应用边界把日期转换为 Unix 毫秒。部署配置为 `QABOT_DATABASE_BACKEND=mysql` 与 `QABOT_MYSQL_URL`；启动会自动执行待处理迁移。真实集成测试只读取 `QABOT_TEST_MYSQL_URL`，不得将其长期指向生产数据库。

图片附件会合并问题的缓存视觉向量结果，以及生成回答明确点名的有效带说明图片或画板。回答辅助选择不会再次请求向量，通用文档图片标签也不会把被引用来源中的所有无说明图片都附加进来。

员工、智能助手与人工客服公开消息使用稳定来源标识投影到 MySQL `conversation_messages`。`dsh_model_sessions` 与 `dsh_model_session_events` 保存恢复会话所需的完整模型历史，门户时间线读取持久业务投影。迁移 11 一次性导入旧 JSONL 会话和服务人员记录，在 `qabot_data_imports` 记录完成状态，并保留源文件作为回退证据。只有旧部署仍缺少消息投影时才需执行 `pnpm --filter @deepseek-ai/dsh-qabot run db:project-messages`；该命令具备幂等性，不会调用语言模型或向量模型。

MySQL `conversation_message_reads` 分别保存员工端和客服端的已读位置。会话列表返回按角色过滤的 `unreadCount`，读取有权访问的会话详情只推进当前查看者的已读位置。迁移 `009_conversation_message_reads.sql` 将已有消息记录为功能启用基线，因此只有后续回复开始参与未读计数。

飞书转人工通知先写入 Outbox，再发送给所选服务组的全部已启用人员。后台任务按指数退避重试，最多八次；相同幂等键只创建一个通知任务。工单状态已变化的旧转人工通知会直接完成而不发送，避免转派后再通知旧队列。

满意度在员工门户聊天界面完成，不通过飞书卡片。工单处于 `resolved` 或 `closed` 时，所属员工可提交一次 1-5 分评价；请求必须携带工单最新 `version`，重复评价或版本冲突返回 HTTP 409。工单不存储服务评论字段。
| `PORTAL_URL` | http://localhost:5173 | 转人工卡片「进入后台」跳转地址 |
| `VISION_EMBED_MODEL` | 未启用 | 视觉向量模型；推荐 `qwen3-vl-embedding`，配置后同步飞书文档图片并启用文搜图 |
| `VISION_EMBED_API_KEY` | `EMBED_API_KEY` | 百炼 API Key；视觉模型使用 DashScope 多模态接口，不走 OpenAI `/embeddings` |
| `VISION_EMBED_BASE_URL` | `https://dashscope.aliyuncs.com/api/v1` | DashScope 多模态 API 地址 |
| `VISION_EMBED_DIMENSION` | 1024 | 视觉向量维度；修改后已有视觉向量会自动增量重算 |
| `VISION_EMBED_MAX_PER_SYNC` | 20 | 单次同步最多生成的缺失或失效视觉向量数量 |
| `VISION_OCR_MODEL` | `qwen-vl-ocr` | 在知识同步时提取变化画板文字的 OpenAI 兼容模型 |
| `VISION_OCR_MAX_TOKENS` | 4096 | 单次画板 OCR 最大输出；密集画板达到上限时拆为重叠区域识别 |

### 日志
- 控制台 + `apps/qabot/data/qabot.log`（带时间戳/级别）
- `apps/qabot/data/` 保存可重建录入索引、本地开发数据库、飞书来源配置、日志和切换 MySQL 前的迁移证据；生产业务状态统一保存在 `hr_system`。

### 开机自启（Windows 任务计划程序）
```powershell
# Register an on-login task from an elevated PowerShell; use the actual local path
schtasks /Create /TN "qabot-service" /TR "cmd /c D:\deepseek_q&a\apps\qabot\start-qabot.bat" /SC ONLOGON /RL HIGHEST /F
# Run it once for verification
schtasks /Run /TN "qabot-service"
# Remove the task
schtasks /Delete /TN "qabot-service" /F
```

### 内网访问
服务监听 `0.0.0.0:3100`，局域网内通过 `http://<本机IP>:3100/` 访问测试页。
注意：Windows 防火墙需放行 3100 端口（`netsh advfirewall firewall add rule name="qabot" dir=in action=allow protocol=TCP localport=3100`）。

## 已知事项

- **中转余额**：`192.168.10.61:3000` 间歇 `Insufficient Balance` → 偶发 STREAM_CLOSED，需充值。
- **空回复自动重试**：中继异常导致回合空回复时自动重试一次，仍空则返回「模型服务暂时异常，请稍后重试」，不再让用户看到空白（重试的系统提示在会话转录中隐藏）。
- **向量索引增量持久化**：MySQL 保存生产文本与视觉向量；录入索引仅在内容哈希、模型或维度变化时重新计算，再把结果投影到 `hr_system`，不会二次调用模型。查询向量缓存避免同一规范化问题和模型重复请求 embedding。
- **在线知识源**：后台人员直接添加飞书链接；每个来源都使用提交人的飞书用户授权同步，授权缺失时不会回退到机器人或其他员工身份。系统支持直接提交 Docx、飞书电子表格和多维表格链接，也支持底层为这些类型的知识库节点。电子表格保留工作表名、列表头和每行字段名；链接指定一个工作表时只建立该工作表的索引。主管再次提交迁移来源的链接时可将来源认领到本人。固定分组只控制维护归属，不限制员工可见范围。默认每五分钟同步一次；内容更新成功时会原子归档此前的已发布版本，检索只读取每份文档中版本号最大的已发布版本。软移除会立即停止文本、向量和图片召回，重新添加同一链接时复用未变化的数据。
- **视觉检索**：设置 `VISION_EMBED_MODEL=qwen3-vl-embedding` 后，飞书文档图片和嵌入画板会在知识录入时下载并增量生成独立视觉向量，素材二进制和向量统一保存到 MySQL。画板使用所在章节作为检索说明，并在每次来源同步时重新下载快照。`VISION_OCR_MODEL` 会在录入阶段提取画板文字并写入可检索知识块；快照内容哈希不变时会同时复用识别文字和视觉向量，不再请求模型。快照变化时只替换该画板的当前素材并重新生成它的识别文字和向量。密集画板只有在整图达到输出上限后才拆成重叠区域识别；空白区域不产生文字，最小区域的结构化结果即使结尾不完整，也会保留其中已经完整返回的文字字段。SVG 画板会先转换为 PNG，超过模型请求限制的素材才会缩放压缩。员工提问不需要明确包含“图片”“图表”或“画板”，文本检索会召回画板文字，视觉检索会附加相关素材。查询向量会持久缓存；没有可用视觉候选时不会调用视觉查询模型。
- **飞书媒体访问**：普通内嵌图片需要 `docs:document.media:download`，嵌入画板需要 `board:whiteboard:node:read`，并且知识源提交人必须仍可访问对应文档或画板。门户加密保存该用户的可续期 OAuth 凭证，只向 Qabot 提供短期访问令牌。普通图片同步会携带父 Docx 上下文，并依次尝试素材下载、原始素材预览流（`preview_type=16`）和临时链接；画板通过飞书画板图片导出接口下载。视觉素材下载被拒绝时，最近一次同步成功的文本和既有素材仍可使用，来源行会记录告警，并且不会消耗视觉模型额度。MySQL 投影会保留未变化素材的 ID，使会话历史中已关联的图片持续可读。自动视觉检索要求素材标题与问题或回答共享具体的非通用主题词，同时要求单个结果达到 `0.45`，或两个相互印证的结果都达到 `0.40` 且差值不超过 `0.02`。匹配素材可以来自任意活跃知识源，回答明确点名的图片仍可展示。部署可通过 `VISION_MEDIA_STRONG_SCORE`、`VISION_MEDIA_CLUSTER_SCORE` 和 `VISION_MEDIA_CLUSTER_MARGIN` 调整阈值。
- **飞书权限**：应用需开通 `im:message:send_as_bot`（发消息）等权限，否则发送会降级为仅记日志。
- 工具注册必须 `defineTool`（裸 register 的 parameters 不转 JSON Schema，中继拒收）。
