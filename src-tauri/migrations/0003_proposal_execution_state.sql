-- Agent 提案执行结果不能只用 executed 表示。
-- running 表示已被原子领取；succeeded/failed 是已知结果；unknown 表示命令可能已发出但结果未确认。
ALTER TABLE agent_proposals ADD COLUMN started_at TEXT;
ALTER TABLE agent_proposals ADD COLUMN finished_at TEXT;
ALTER TABLE agent_proposals ADD COLUMN execution_error TEXT;
ALTER TABLE agent_proposals ADD COLUMN audit_id INTEGER;
ALTER TABLE agent_proposals ADD COLUMN exit_code INTEGER;

-- 旧版本在执行前就写 executed，无法从数据库还原真实执行结果，保守标记为 unknown。
UPDATE agent_proposals
SET status = 'unknown',
    execution_error = '由旧版 executed 状态迁移，实际结果需要人工核对',
    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE status = 'executed';
