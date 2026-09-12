-- success 只能表达已知成功/非成功，无法区分待执行、已知失败和结果未知。
ALTER TABLE audit_logs ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown';

UPDATE audit_logs
SET outcome = CASE WHEN success = 1 THEN 'succeeded' ELSE 'failed' END;

CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_logs(outcome);
