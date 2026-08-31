# Agent Note: Qabot 会话发现使用仓库根目录

Status: implemented

[English](2026-08-31-qabot-session-discovery-uses-repository-root.md) | 中文

## Problem

Qabot 将会话元数据保存在所选业务数据库中，而 DSH 将模型可见的会话事件保存在 `apps/qabot/data/sessions` 下。当 Qabot 进程以 `apps/qabot` 作为工作目录启动时，它仍能列出 MySQL 会话，但会话发现代码相对于 `process.cwd()` 拼接 `apps/qabot/data/sessions`。这个重复目录中没有持久日志，因此 Qabot 会为已有 id 创建空的内存会话，并返回空 transcript（文本记录）。

## Decision

`bin.ts` 根据自身模块位置推导仓库根目录，并将该绝对路径传给 `Qabot`。会话发现与历史工作区选择只通过注入的根目录解析 `apps/qabot/data/sessions`。进程工作目录仍可作为会话中记录的 agent 工作区，但不作为存储定位信息。

已有日志继续支持两种历史工作区编码：以仓库根目录创建的会话使用仓库根目录恢复，编码工作区包含 `apps-qabot` 的目录使用 `apps/qabot` 恢复。Qabot 确认持久产物存在后，仍由会话持久化后端负责唯一 id 发现与日志解码。

## Alternatives considered

- **要求每个启动器先切换到仓库根目录。** 批处理启动器已经这样执行，但包脚本与服务管理器通常从 `apps/qabot` 启动。仅约束启动方式无法保护未来入口的存储查找。
- **将会话事件复制到 MySQL。** 这会重复保存 DSH 事件日志，并引入对账和排序规则。MySQL 继续作为业务查询投影；DSH 日志继续作为模型可见事件的权威记录。
- **继续使用 `process.cwd()` 并增加父目录启发式判断。** 启发式判断仍使持久化依赖启动上下文，而且通过其他包装层调用 Qabot 时可能解析到错误仓库。

## Consequences

无论从仓库根目录、`apps/qabot` 还是服务管理器的工作目录启动，会话历史都以相同方式恢复。已有磁盘日志不需要迁移。Qabot 构造时必须接收仓库根目录，因此错误存储根目录会明确暴露在应用组装位置。

## Testing

Qabot 单元测试在临时仓库根目录下创建两种历史项目目录布局，并验证持久日志发现和工作区解析不会读取测试进程工作目录。员工门户浏览器检查验证服务重启后，已有 MySQL 会话会渲染从 DSH 恢复的消息。
