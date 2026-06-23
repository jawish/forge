-- Forge analytics database (docs/12 §5). The session_event table + the outcome
-- rollup MV are created by 02-schema.sql (mirrors @forge/domain's SESSION_EVENT_DDL
-- verbatim — single source of truth is docs/12 §5).
CREATE DATABASE IF NOT EXISTS forge;
