# Agent Note: Store readable Qabot MySQL dates

Status: implemented

English | [中文](2026-09-01-qabot-readable-mysql-datetimes.zh.md)

## Problem

Qabot stored business dates in MySQL as Unix millisecond integers. Direct database inspection therefore required manual conversion before operators could identify when conversations, messages, tickets, knowledge versions, reviews, or integration jobs changed.

## Decision

Qabot MySQL business dates use Asia/Shanghai `DATETIME(3)` columns. Database values display as `YYYY-MM-DD HH:mm:ss.SSS`, and column comments name the business event without presenting the value as a Unix timestamp. Integer columns remain in use for identifiers, counters, source ordering, optimistic versions, and unread message positions.

Repository interfaces and HTTP responses continue to use Unix milliseconds. The MySQL adapter sends JavaScript `Date` parameters and converts returned dates to milliseconds, so timeout calculations, chronological ordering, and portal response fields retain their existing semantics. MySQL connections use the `+08:00` zone, and migration 10 converts stored millisecond values in the same zone while preserving millisecond precision.

## Alternatives considered

- **Keep integer timestamps and expose formatted query views:** rejected because ordinary table inspection and downstream reporting would continue to encounter unreadable source fields.
- **Store formatted text:** rejected because text permits invalid dates and gives up native date comparison, arithmetic, and indexing.
- **Maintain integer and date columns together:** rejected because duplicate time representations can drift and force every writer to update both values.
- **Change every application interface to date strings:** rejected because storage readability does not require changing timeout arithmetic or the established portal API.

## Consequences

Operators can read MySQL dates without conversion, and native date predicates remain available. The adapter owns the single conversion point between readable database values and millisecond application values. Ticket statistics use `TIMESTAMPDIFF` instead of numeric subtraction. Deployments must apply migration 10 before code that writes `Date` parameters serves traffic, and future MySQL business-time fields use `DATETIME(3)` in the same zone.
