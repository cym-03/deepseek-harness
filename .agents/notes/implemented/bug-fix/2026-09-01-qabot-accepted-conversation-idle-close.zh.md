# Agent Note: 空闲后关闭已接单的 Qabot 会话

Status: implemented

[English](2026-09-01-qabot-accepted-conversation-idle-close.md) | 中文

## Problem

空闲检查只关闭纯智能 `open` 工单。已接单的人工服务工单在双方停止回复后可能永久停留在 `in_service` 或 `waiting_employee`，员工会话因此无法进入 `closed`，也不会显示评分控件。

## Decision

Qabot 按 `QABOT_IDLE_SWEEP_MS` 执行空闲检查；工单的 `updated_at` 早于 `QABOT_IDLE_CONVERSATION_MS` 计算出的截止时间时，系统关闭符合条件的会话。符合条件的工单包括纯智能 `open` 工单，以及处于 `in_service`、`waiting_employee` 或 `reopened` 的已接单人工服务工单。`waiting_agent` 工单不符合条件，因为尚无服务人员接单。

关闭操作会把 `status` 设为 `closed`，在 `service_end` 为空时记录结束时间，递增乐观并发 `version`，并保留已有满意度分数。当一次检查至少关闭一个工单时，Qabot 会发出实时变更，让已连接的员工页面和服务台页面刷新当前会话；正在查看受影响会话的员工无需刷新页面即可看到现有评分控件。

SQLite、MySQL 和 PostgreSQL Repository 使用相同的状态条件。Repository 测试固定验证过期纯智能会话和已接单人工会话会关闭，尚未接单的转人工工单保持不变。

## Alternatives considered

- **空闲后关闭所有活动工单：** 拒绝，因为尚未接单的转人工工单表示排队中的工作，不是已分配服务人员停止参与的会话。
- **要求服务人员手动关闭每一张已接单工单：** 拒绝，因为被遗弃的浏览器会话会持续占用处理中队列，并使员工无法评分。
- **只在前端推断会话结束：** 拒绝，因为工单状态、报表、权限和评分都需要同一个持久化数据库状态迁移。

## Consequences

纯智能会话和已接单人工会话会在配置的无活动时限后完成并开放评分。尚未接单的工单会继续留在共享待接单队列，直到服务人员接单、转接或关闭。一次有关闭结果的检查会向已连接门户客户端广播一条刷新事件；该过程不会调用语言模型或向量模型。
