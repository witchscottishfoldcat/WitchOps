import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { AuditLog, AuditFilter } from '../types/backend';
import { ShieldCheck, Search, CheckCircle, XCircle, Terminal, Eye, AlertCircle } from 'lucide-react';

export const AuditLogs: React.FC = () => {
  const { auditStats, auditLogs, servers, refreshAuditLogs } = useApp();
  const [filter, setFilter] = useState<AuditFilter>({});
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  // 把筛选交给后端，搜索覆盖整个审计表；短暂防抖避免每次按键都查询。
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshAuditLogs({ ...filter, limit: 100, offset: 0 });
    }, 250);
    return () => clearTimeout(timer);
  }, [filter, refreshAuditLogs]);

  const logs = auditLogs;

  return (
    <div>
      <div className="page-title-row">
        <div>
          <h2 className="page-title">
            <ShieldCheck size={24} style={{ color: 'var(--accent-emerald)' }} />
            审计日志 (Unified Audit Trail - 需求1)
          </h2>
          <p className="page-subtitle">记录 Agent、快捷指令、服务控制与 SFTP 操作；输出保存受限摘要，结果未知时需要人工核对。</p>
        </div>
      </div>

      {/* Audit Stats Header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16, marginBottom: 20 }}>
        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ background: 'var(--info-bg)', padding: 10, borderRadius: 8, color: 'var(--accent-cyan)' }}>
            <Terminal size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>累计审计命令数</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{auditStats.total} 条</div>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 14, borderLeft: '4px solid var(--accent-emerald)' }}>
          <div style={{ background: 'rgba(16, 185, 129, 0.2)', padding: 10, borderRadius: 8, color: 'var(--accent-emerald)' }}>
            <CheckCircle size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>成功执行记录</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent-emerald)' }}>{auditStats.success} 次</div>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 14, borderLeft: '4px solid var(--accent-rose)' }}>
          <div style={{ background: 'rgba(244, 63, 94, 0.2)', padding: 10, borderRadius: 8, color: 'var(--accent-rose)' }}>
            <XCircle size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>异常与被拦截</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent-rose)' }}>{auditStats.failed} 次</div>
          </div>
        </div>
        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 14, borderLeft: '4px solid var(--accent-amber)' }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.15)', padding: 10, borderRadius: 8, color: 'var(--accent-amber)' }}>
            <AlertCircle size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>待核对 / 执行中</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent-amber)' }}>{auditStats.unknown + auditStats.pending} 次</div>
          </div>
        </div>
      </div>

      {/* Audit Filters Bar */}
      <div className="glass-card" style={{ marginBottom: 16, padding: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-dim)' }} />
          <input
            className="input-field"
            placeholder="搜索命令或关键字..."
            style={{ paddingLeft: 30, fontSize: 12, height: 32 }}
            value={filter.search || ''}
            onChange={e => setFilter({ ...filter, search: e.target.value })}
          />
        </div>

        <select
          className="input-field"
          style={{ width: 150, height: 32, fontSize: 12 }}
          value={filter.source || ''}
          onChange={e => setFilter({ ...filter, source: e.target.value || undefined })}
        >
          <option value="" style={{ background: 'var(--apple-popover-bg)' }}>全部分类 Source</option>
          <option value="agent" style={{ background: 'var(--apple-popover-bg)' }}>Agent 自动</option>
          <option value="manual_terminal" style={{ background: 'var(--apple-popover-bg)' }}>手动 PTY 终端</option>
          <option value="quick_action" style={{ background: 'var(--apple-popover-bg)' }}>快捷指令</option>
          <option value="mcp_external" style={{ background: 'var(--apple-popover-bg)' }}>MCP 外部调用</option>
        </select>

        <select
          className="input-field"
          style={{ width: 160, height: 32, fontSize: 12 }}
          value={filter.server_id || ''}
          onChange={e => setFilter({ ...filter, server_id: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="" style={{ background: 'var(--apple-popover-bg)' }}>全部服务器节点</option>
          {servers.map(s => (
            <option key={s.id} value={s.id} style={{ background: 'var(--apple-popover-bg)' }}>{s.name} ({s.host})</option>
          ))}
        </select>

        {(filter.search || filter.source || filter.server_id) && (
          <button className="btn btn-secondary" style={{ height: 32, fontSize: 12 }} onClick={() => setFilter({})}>
            重置筛选条件
          </button>
        )}
      </div>

      {/* Logs Table */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>ID & 时间</th>
              <th>来源 (Source)</th>
              <th>目标服务器</th>
              <th>工具名称 (Tool)</th>
              <th>执行命令 (Command)</th>
              <th>耗时</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(log => (
              <tr key={log.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  <div>#{log.id}</div>
                  <div style={{ color: 'var(--text-dim)' }}>{new Date(log.timestamp).toLocaleTimeString()}</div>
                </td>
                <td>
                  <span style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: log.source === 'agent' ? 'var(--chip-bg)' : 'var(--panel-inset-bg)',
                    color: log.source === 'agent' ? 'var(--accent-purple)' : 'var(--text-main)'
                  }}>
                    {log.source}
                  </span>
                </td>
                <td>{log.server_host}</td>
                <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>{log.tool_name}</td>
                <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-main)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.command || '-'}
                </td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{log.duration_ms} ms</td>
                <td>
                  {log.outcome === 'succeeded' ? (
                    <span style={{ color: 'var(--accent-emerald)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <CheckCircle size={14} /> 成功
                    </span>
                  ) : log.outcome === 'pending' ? (
                    <span style={{ color: 'var(--accent-amber)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AlertCircle size={14} /> 执行中
                    </span>
                  ) : log.outcome === 'unknown' ? (
                    <span style={{ color: 'var(--accent-amber)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AlertCircle size={14} /> 待核对
                    </span>
                  ) : (
                    <span style={{ color: 'var(--accent-rose)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <XCircle size={14} /> 失败
                    </span>
                  )}
                </td>
                <td>
                  <button className="btn btn-secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setSelectedLog(log)}>
                    <Eye size={12} /> 详细
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Log Detail Drawer Modal */}
      {selectedLog && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ width: 680 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>审计日志详情 #{selectedLog.id}</h3>
              <button className="btn btn-secondary" style={{ padding: 4 }} onClick={() => setSelectedLog(null)}>
                <XCircle size={16} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12, marginBottom: 16 }}>
              <div><strong>执行时间:</strong> {new Date(selectedLog.timestamp).toLocaleString()}</div>
              <div><strong>来源类型:</strong> {selectedLog.source}</div>
              <div><strong>工具名称:</strong> {selectedLog.tool_name}</div>
              <div><strong>审批来源:</strong> {selectedLog.approved_by || '无'}</div>
              <div><strong>会话 ID:</strong> {selectedLog.session_id || '无'}</div>
              <div><strong>耗时:</strong> {selectedLog.duration_ms} ms</div>
              <div><strong>结果状态:</strong> {selectedLog.outcome}</div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>执行 Shell 指令:</label>
              <div style={{ background: 'var(--code-bg)', padding: 10, borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-cyan)' }}>
                {selectedLog.command}
              </div>
            </div>

            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>日志输出 (Stdout / Stderr 截断到 2000 字符):</label>
              <div style={{ background: 'var(--code-bg)', padding: 10, borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--code-fg)', maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                {selectedLog.output}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
