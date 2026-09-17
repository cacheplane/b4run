---
"@b4run/memory-pgvector": patch
---

Behavior change: `@b4run/memory-pgvector` now requires `schema` and `tablePrefix` to be lowercase. Both are interpolated into DDL unquoted, and Postgres folds an unquoted identifier to lowercase, so a value like `MySchema` created `myschema` and never named the tables the store then queried. Such a value now throws at construction. Pass the lowercase spelling the database was already using. The enforced pattern is exported as `IDENTIFIER_PATTERN`, matching `@b4run/postgres-storage`.
