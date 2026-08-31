# Agent Note: 使用可等待 Repository 隔离 Qabot 持久化

Status: implemented

[English](2026-08-27-qabot-repository-ports.md) | 中文

## Problem

Qabot 应用代码直接依赖同步 SQLite Store 类。PostgreSQL 实现必然执行异步 I/O，如果不先隔离数据访问，替换存储时就必须同时修改会话、工单、报表、满意度、HTTP 和 Outbox 行为。

## Decision

Conversation、Ticket、Audit 和 Outbox 持久化通过领域 Repository 接口提供。返回值均可等待：SQLite 实现可以同步完成，网络数据库实现可以返回 Promise。应用调用方统一等待可能更换实现的方法结果。

现有 SQLite Store 实现这些接口，并继续作为开发和测试 Provider。`migrations/postgres/001_service_desk.sql` 定义首版生产结构，覆盖会话投影、带版本工单与回复、审计记录以及可领取的 Outbox 行。PostgreSQL 迁移使用单调 `schema_migrations` 表，并保留毫秒整数时间戳，避免更换后端时同时改变应用数据语义。`migrate-postgres` 命令加载连续编号的 `NNN_name.sql` 文件，持有数据库 advisory lock，在单个事务中执行每个待执行文件，并且只在成功后记录版本。

PostgreSQL 驱动和迁移执行器要求提供 `QABOT_DATABASE_URL`。PostgreSQL 已实现 Conversation、Ticket、Audit 和 Outbox Provider。Ticket 保留 SQLite 的状态、事务、乐观版本、评分和统计行为。Outbox Provider 使用 `FOR UPDATE SKIP LOCKED` 领取行，记录工作进程，并在租约到期后恢复遗留领取。`QABOT_DATABASE_BACKEND` 选择 `sqlite` 或 `postgres`；PostgreSQL 启动会在组合服务前执行待处理迁移。Qabot 引擎、HTTP 服务、Outbox 后台任务和模型侧转人工工具接收同一个 Repository 组合，因此一次操作不会分散写入两个后端。

公司实际部署数据库为 MySQL `hr_system`。MySQL 迁移器和初始结构与 PostgreSQL 方言分开维护。迁移器使用 `GET_LOCK` 串行执行；由于 MySQL DDL 会隐式提交，执行前先记录 dirty 迁移，遇到 dirty 版本时拒绝继续。MySQL 已实现四类 Repository Provider，包括工单回复事务、乐观并发更新、Outbox 租约领取和遗留领取恢复。运行时选择接受 `mysql`，要求提供 `QABOT_MYSQL_URL`，并在组合服务前执行待处理 MySQL 迁移。

## Alternatives considered

- **应用服务继续使用 SQLite 类：** 拒绝，因为选择数据库会把连接与查询行为泄漏到每个领域流程。
- **强制 SQLite 方法返回 Promise：** 拒绝，因为给每个本地操作增加人为 Promise 只会产生实现噪声；`await` 同时接受即时结果和 Promise。
- **Provider 完成前增加 PostgreSQL 配置：** 拒绝，因为看似可用于生产但静默使用 SQLite 或启动后才失败的选项不安全。
- **改用 PostgreSQL 时间戳：** 首次迁移不采用，因为这会把存储替换与 API、时间计算变化混在一起。

## Consequences

应用流程不再要求具体 SQLite 类，并已适配网络延迟。SQLite 保持默认后端；PostgreSQL 缺少明确 URL 时启动失败，不会把生产写入回落到本地文件。迁移文件名必须连续，失败文件不会记录版本，并发迁移器会通过 advisory lock 串行执行。PostgreSQL 集成测试在明确设置 `QABOT_TEST_POSTGRES_URL` 时同时验证 Ticket 并发、评分和其他 Repository，并清理测试创建的唯一标识记录。部署仍然需要可达数据库和已验证的连接凭据。

MySQL 数据结构 DDL 无法通过事务回滚，因此迁移失败后可能需要人工修复才能清除 dirty 记录。MySQL 集成测试只有在明确设置 `QABOT_TEST_MYSQL_URL` 时运行，不会隐式复用生产连接。迁移 1 已应用到 `hr_system`，所有表和字段均有中文备注，迁移状态干净；临时记录冒烟测试通过后已清空全部业务数据。
