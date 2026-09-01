# Qabot development rules

- Every MySQL table column has a non-empty Chinese `COMMENT`; every table has a non-empty Chinese `COMMENT`.
- Text columns explicitly use `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`; tables use the same default character set and collation.
- Add MySQL schema changes as consecutive migrations under `migrations/mysql/`; never edit an applied migration after production use.
- Store business dates and times as Asia/Shanghai `DATETIME(3)` columns; reserve integer columns for identifiers, counters, and ordering values.
- Run the Qabot tests after changing MySQL DDL; the schema-style test rejects missing Chinese comments or inconsistent text collations.
