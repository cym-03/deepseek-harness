# Agent Note: 为 Qabot 每个 MySQL 字段添加中文备注

Status: implemented

[English](2026-08-27-qabot-mysql-schema-comments.md) | 中文

## Problem

公司数仓由中文使用者直接运维和检查。MySQL 字段没有数据库原生说明时，管理员必须查找应用源码才能区分员工标识、时间戳、流程状态和集成字段。

## Decision

Qabot 每个 MySQL 字段都带有非空中文 `COMMENT`，每张表也带有非空中文表备注。文本字段显式声明 `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`，每张表使用相同默认值。字段备注说明业务含义；单位或允许值会影响理解时一并写明。

该规则同时适用于迁移管理的业务表和迁移器创建的迁移元数据表。`apps/qabot/AGENTS.md` 记录长期开发要求。无需密钥的结构规范测试会扫描 MySQL 迁移 SQL 和迁移器持有的 DDL，拒绝缺少中文字段备注、缺少中文表备注和文本排序规则漂移。

## Alternatives considered

- **只在 TypeScript 中记录字段说明：** 拒绝，因为数据库管理员和报表工具不会加载应用类型就直接检查 MySQL。
- **只依赖表备注：** 拒绝，因为同一张表包含含义不同的标识、状态、时间戳和内容。
- **只使用表级默认字符集：** 拒绝，因为字段显式声明可以让生成和评审的 DDL 与公司结构规范保持一致。
- **只通过人工评审备注：** 拒绝，因为后续迁移遗漏备注时不会产生运行错误。

## Consequences

检查 MySQL 结构时可以直接看到每个字段的中文业务含义，文本比较统一使用已验证的 MySQL 8 排序规则。DDL 会更长，但自动化测试可以防止说明漂移。PostgreSQL 和 SQLite 不支持相同的 MySQL 内联语法；该规则约束 MySQL 迁移，应用类型继续保留简洁契约。
