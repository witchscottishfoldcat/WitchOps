import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { Server, ServerInput } from '../types/backend';
import { Server as ServerIcon, Plus, Terminal, Power, Tag, Trash2, Eye, EyeOff, X, Lock, KeyRound, ShieldCheck, ShieldAlert, Edit } from 'lucide-react';

/** 安全 JSON 解析:渲染期非法 JSON 返回 null,避免白屏 */
function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export const ServerManager: React.FC = () => {
  const {
    servers, connectedServerIds, connectServer, disconnectServer,
    openTerminal, addServer, updateServer, deleteServer, setActiveServerId, activeServerId, isVaultUnlocked, isVaultInitialized
  } = useApp();

  const [selectedTag, setSelectedTag] = useState<string>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  // 输入框内按住拖动选中文本时,mouseup 可能落在遮罩上;此时浏览器把 click 派发到共同祖先(遮罩),
  // 仅凭 stopPropagation 拦不住。只有按下与抬起都发生在遮罩本身,才视为"点击外部关闭"。
  const overlayMouseDown = useRef(false);
  const overlayMouseUp = useRef(false);

  // 两步确认:3 秒后自动复位
  useEffect(() => {
    if (confirmDeleteId === null) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const [formData, setFormData] = useState<ServerInput>({
    name: '',
    host: '',
    port: 22,
    username: 'root',
    auth_method: 'password',
    credential: '',
    tags: ['prod'],
    note: ''
  });

  const filteredServers = servers.filter(s => {
    if (selectedTag === 'all') return true;
    const tagArr: string[] = safeParse<string[]>(s.tags) ?? [];
    return tagArr.includes(selectedTag);
  });

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.host) return;
    setSaving(true);
    try {
      if (editingId !== null) {
        // 编辑模式:credential 留空时后端保留原密码
        await updateServer(editingId, formData);
      } else {
        await addServer(formData);
      }
      setShowAddModal(false);
      setShowPassword(false);
      setEditingId(null);
      setFormData({ name: '', host: '', port: 22, username: 'root', auth_method: 'password', credential: '', tags: ['prod'], note: '' });
    } catch {
      // 保存失败时保留弹窗和表单数据,错误已由 context toast 提示
    } finally {
      setSaving(false);
    }
  };

  /** 打开编辑弹窗:把现有服务器数据填入表单(凭证留空,提示保留原值) */
  const handleEdit = (s: Server) => {
    const tags: string[] = safeParse<string[]>(s.tags) ?? [];
    setEditingId(s.id);
    setFormData({
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      auth_method: s.auth_method as 'password' | 'private_key',
      credential: '',  // 留空:后端检测到空值时保留原凭证
      tags: tags.length > 0 ? tags : ['prod'],
      note: s.note ?? '',
    });
    setShowAddModal(true);
  };

  /** 打开新增弹窗 */
  const handleAdd = () => {
    setEditingId(null);
    setFormData({ name: '', host: '', port: 22, username: 'root', auth_method: 'password', credential: '', tags: ['prod'], note: '' });
    setShowAddModal(true);
  };

  const closeModal = () => {
    setShowAddModal(false);
    setShowPassword(false);
    setEditingId(null);
  };

  // 苹果风表单标签样式
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--apple-text-muted)',
    marginBottom: 6,
    display: 'block',
    letterSpacing: 0.2,
  };

  return (
    <div>
      <div className="page-title-row">
        <div>
          <h2 className="page-title">
            <ServerIcon size={24} style={{ color: 'var(--accent-purple)' }} />
            服务器管理 (Servers & Nodes)
          </h2>
          <p className="page-subtitle">管理与连接底层 SSH 节点，支持加密凭证与指纹防护，一键调起 PTY 交互流与 Agent 运维。</p>
        </div>
        <button className="btn btn-primary" onClick={handleAdd}>
          <Plus size={16} /> 添加服务器节点
        </button>
      </div>

      {/* Tag Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['all', 'prod', 'web', 'k8s', 'db', 'staging'].map(tag => (
          <button
            key={tag}
            className={`btn ${selectedTag === tag ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: 12, padding: '4px 12px', height: 28 }}
            onClick={() => setSelectedTag(tag)}
          >
            <Tag size={12} /> {tag.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Server Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
        {filteredServers.map(s => {
          const isConnected = connectedServerIds.has(s.id);
          const isSelected = activeServerId === s.id;
          const tags: string[] = safeParse<string[]>(s.tags) ?? [];
          const confirming = confirmDeleteId === s.id;

          return (
            <div
              key={s.id}
              className="glass-card"
              style={{
                borderColor: isSelected ? 'var(--accent-purple)' : undefined,
                boxShadow: isSelected ? '0 0 15px var(--chip-border)' : undefined
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 700 }}>{s.name}</h3>
                    <span className={`badge ${isConnected ? 'badge-connected' : 'badge-disconnected'}`}>
                      {isConnected ? '已连接' : '未连接'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                    {s.username}@{s.host}:{s.port}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: 6, borderRadius: '50%' }}
                    onClick={() => handleEdit(s)}
                    title="编辑服务器"
                  >
                    <Edit size={14} style={{ color: 'var(--text-dim)' }} />
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{
                      padding: 6, borderRadius: '50%',
                      color: confirming ? '#fff' : undefined,
                      background: confirming ? 'var(--accent-rose)' : undefined,
                      borderColor: confirming ? 'var(--accent-rose)' : undefined,
                    }}
                    onClick={() => {
                      if (confirming) {
                        setConfirmDeleteId(null);
                        deleteServer(s.id);
                      } else {
                        setConfirmDeleteId(s.id);
                      }
                    }}
                    title={confirming ? '再次点击确认删除(含凭证)' : '删除服务器'}
                  >
                    <Trash2 size={14} style={{ color: confirming ? '#fff' : 'var(--text-dim)' }} />
                  </button>
                </div>
              </div>

              {/* Tags */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
                {tags.map(t => (
                  <span key={t} style={{ background: 'var(--panel-inset-bg)', color: 'var(--text-muted)', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                    #{t}
                  </span>
                ))}
              </div>

              {/* Server Metadata */}
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, background: 'var(--panel-inset-bg)', padding: 8, borderRadius: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span>认证类型:</span>
                  <span style={{ color: 'var(--text-main)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {s.auth_method === 'private_key' ? <><KeyRound size={13} /> SSH 私钥</> : <><Lock size={13} /> 密码认证</>}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span>指纹状态:</span>
                  <span style={{ color: s.host_key_fingerprint ? 'var(--accent-emerald)' : 'var(--accent-amber)', fontSize: 11 }}>
                    {s.host_key_fingerprint ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ShieldCheck size={12} /> 已校验 (SHA256)</span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ShieldAlert size={12} /> 未校验 (等待首连)</span>
                    )}
                  </span>
                </div>
                {s.note && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{s.note}</div>}
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 8 }}>
                {isConnected ? (
                  <>
                    <button
                      className="btn btn-danger"
                      style={{ flex: 1, fontSize: 12, justifyContent: 'center' }}
                      onClick={() => disconnectServer(s.id)}
                    >
                      <Power size={14} /> 断开连接
                    </button>
                    <button
                      className="btn btn-primary"
                      style={{ flex: 1, fontSize: 12, justifyContent: 'center' }}
                      onClick={() => {
                        setActiveServerId(s.id);
                        openTerminal(s.id);
                      }}
                    >
                      <Terminal size={14} /> 打开 PTY 终端
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-success"
                    style={{ width: '100%', fontSize: 12, justifyContent: 'center' }}
                    onClick={() => {
                      setActiveServerId(s.id);
                      connectServer(s.id);
                    }}
                  >
                    <Power size={14} /> 连接服务器
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Server Modal — 苹果风表单 */}
      {showAddModal && (
        <div
          className="modal-overlay"
          onMouseDown={e => { overlayMouseDown.current = e.target === e.currentTarget; }}
          onMouseUp={e => { overlayMouseUp.current = e.target === e.currentTarget; }}
          onClick={() => { if (overlayMouseDown.current && overlayMouseUp.current) closeModal(); }}
        >
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ width: 520 }}>
            {/* 标题栏 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.2 }}>
                {editingId !== null ? '编辑 SSH 服务器节点' : '添加 SSH 服务器节点'}
              </h3>
              <button
                type="button"
                onClick={closeModal}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--apple-text-muted)', padding: 4, borderRadius: 6, display: 'flex' }}
                title="关闭"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAddSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* 已启用但锁定:保存会失败,强提示 */}
              {isVaultInitialized && !isVaultUnlocked && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: 'rgba(255, 159, 10, 0.1)',
                    border: '1px solid rgba(255, 159, 10, 0.2)',
                    color: 'var(--apple-yellow)',
                    fontSize: 12,
                  }}
                >
                  <Lock size={14} />
                  <span>Vault 已锁定,保存凭证需要先解锁。请先到设置页解锁 Vault。</span>
                </div>
              )}
              {/* 未启用:弱提示存储方式 */}
              {!isVaultInitialized && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'var(--panel-inset-bg)',
                    border: '1px solid var(--apple-border)',
                    color: 'var(--apple-text-muted)',
                    fontSize: 11,
                  }}
                >
                  <Lock size={12} />
                  <span>Vault 未启用:凭证将以明文保存在项目 data 目录(可在设置中启用加密)。</span>
                </div>
              )}

              {/* 节点名称 */}
              <div>
                <label style={labelStyle}>节点名称</label>
                <input
                  className="input-field"
                  placeholder="e.g. prod-api-gateway"
                  required
                  autoFocus
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              {/* 主机 + 端口 */}
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 2 }}>
                  <label style={labelStyle}>主机地址 (IP / Domain)</label>
                  <input
                    className="input-field"
                    placeholder="192.168.1.100"
                    required
                    value={formData.host}
                    onChange={e => setFormData({ ...formData, host: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>SSH 端口</label>
                  <input
                    type="number"
                    className="input-field"
                    value={formData.port}
                    onChange={e => setFormData({ ...formData, port: Number(e.target.value) })}
                  />
                </div>
              </div>

              {/* 用户名 + 认证方式 */}
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>用户名</label>
                  <input
                    className="input-field"
                    placeholder="root"
                    value={formData.username}
                    onChange={e => setFormData({ ...formData, username: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>认证方式</label>
                  <select
                    className="input-field"
                    value={formData.auth_method}
                    onChange={e => {
                      setFormData({ ...formData, auth_method: e.target.value as any, credential: '' });
                      setShowPassword(false);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <option value="password" style={{ background: 'var(--apple-popover-bg)' }}><Lock size={13} /> 密码认证</option>
                    <option value="private_key" style={{ background: 'var(--apple-popover-bg)' }}><KeyRound size={13} /> SSH 私钥</option>
                  </select>
                </div>
              </div>

              {/* 凭证:按认证方式区分输入形式 */}
              {formData.auth_method === 'password' ? (
                <div>
                  <label style={labelStyle}>
                    登录密码
                    {editingId !== null && (
                      <span style={{ color: 'var(--apple-text-dim)', fontWeight: 400 }}> (留空保留原密码)</span>
                    )}
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      className="input-field"
                      placeholder={editingId !== null ? '留空则保留原密码' : '输入密码(将以 AES-GCM-256 加密存入 Vault)'}
                      required={editingId === null}
                      value={formData.credential}
                      onChange={e => setFormData({ ...formData, credential: e.target.value })}
                      style={{ paddingRight: 40 }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--apple-text-muted)', display: 'flex', padding: 2 }}
                      title={showPassword ? '隐藏密码' : '显示密码'}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <label style={labelStyle}>
                    PEM 私钥
                    {editingId !== null && (
                      <span style={{ color: 'var(--apple-text-dim)', fontWeight: 400 }}> (留空保留原私钥)</span>
                    )}
                  </label>
                  <textarea
                    className="input-field"
                    rows={4}
                    placeholder={editingId !== null ? '留空则保留原私钥' : '-----BEGIN OPENSSH PRIVATE KEY-----\n(粘贴完整私钥内容,将加密存入 Vault)'}
                    required={editingId === null}
                    value={formData.credential}
                    onChange={e => setFormData({ ...formData, credential: e.target.value })}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
                  />
                </div>
              )}

              {/* 备注 */}
              <div>
                <label style={labelStyle}>备注说明 <span style={{ color: 'var(--apple-text-dim)', fontWeight: 400 }}>(可选)</span></label>
                <input
                  className="input-field"
                  placeholder="集群角色、业务用途等"
                  value={formData.note}
                  onChange={e => setFormData({ ...formData, note: e.target.value })}
                />
              </div>

              {/* 操作按钮 */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--apple-border)' }}>
                <button type="button" className="btn btn-secondary" onClick={closeModal} disabled={saving}>取消</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? '保存中…' : (editingId !== null ? '保存修改' : '保存节点')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

