import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { ProviderInput, ProviderSummary, UpdateCheckResult } from '../types/backend';
import { Settings, Plus, Trash2, Cpu, Lock, Pencil, RefreshCw, CheckCircle2, ArrowUpCircle, AlertCircle, ExternalLink } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { VaultModal } from './VaultModal';
import { checkAppUpdate } from '../lib/ipc';

/** 安全 JSON 解析:渲染期非法 JSON 返回 null,避免白屏 */
function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export const SettingsManager: React.FC = () => {
  const { providers, addProvider, updateProvider, deleteProvider, isVaultUnlocked, isVaultInitialized } = useApp();
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** 正在编辑的 provider(null = 新建) */
  const [editingProvider, setEditingProvider] = useState<ProviderSummary | null>(null);

  // 两步确认:3 秒后自动复位
  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const [formData, setFormData] = useState<ProviderInput>({
    name: '',
    base_url: '',
    api_key: '',
    default_model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner']
  });

  const isEditing = editingProvider !== null;

  // ============ 软件更新(手动检查 GitHub Releases) ============
  const [appVersion, setAppVersion] = useState<string>('dev');
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // getVersion 在非 Tauri 环境会同步抛错,先包一层
    let promise: Promise<string>;
    try {
      promise = getVersion();
    } catch {
      promise = Promise.resolve('dev');
    }
    promise
      .then(v => { if (!cancelled) setAppVersion(v); })
      .catch(() => { if (!cancelled) setAppVersion('dev'); });
    return () => { cancelled = true; };
  }, []);

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateError(null);
    setUpdateResult(null);
    try {
      setUpdateResult(await checkAppUpdate());
    } catch (e) {
      // 后端错误形如 {code,message};纯 Web 预览为 Error
      setUpdateError(e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
    } finally {
      setChecking(false);
    }
  };

  /** 打开发布页:Tauri 内走 opener 插件,纯 Web 预览退化为 window.open */
  const openReleasePage = async (url: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  };

  const openCreate = () => {
    setEditingProvider(null);
    setFormData({ name: '', base_url: '', api_key: '', default_model: 'deepseek-chat', models: ['deepseek-chat'] });
    setShowModal(true);
  };

  const openEdit = (p: ProviderSummary) => {
    setEditingProvider(p);
    setFormData({
      name: p.name,
      base_url: p.base_url,
      api_key: '', // 留空 = 保持现有 key(后端 COALESCE)
      default_model: p.default_model || '',
      models: safeParse<string[]>(p.models) ?? [],
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.base_url) return;
    // 新建必须提供 key;编辑时留空表示保持不变
    if (!isEditing && !formData.api_key) return;
    setSaving(true);
    try {
      if (isEditing && editingProvider) {
        await updateProvider(editingProvider.id, { ...formData, api_key: formData.api_key || '' });
      } else {
        await addProvider(formData);
      }
      setShowModal(false);
      setEditingProvider(null);
      setFormData({ name: '', base_url: '', api_key: '', default_model: 'deepseek-chat', models: ['deepseek-chat'] });
    } catch {
      // 保存失败时保留弹窗和表单数据,错误已由 context toast 提示
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-title-row">
        <div>
          <h2 className="page-title">
            <Settings size={24} style={{ color: 'var(--accent-purple)' }} />
            设置与 LLM Provider 管理 (Settings & Vault)
          </h2>
          <p className="page-subtitle">配置加密 Vault 主密码，关联 DeepSeek、Claude、OpenAI 等后端大模型 API 服务商。</p>
        </div>
      </div>

      {/* Vault Security Status Banner */}
      <VaultModal />

      {/* 软件更新(手动检查 GitHub Releases) */}
      <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--chip-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <RefreshCw size={18} style={{ color: 'var(--accent-purple)' }} />
          </div>
          <div>
            <h4 style={{ fontSize: 14, fontWeight: 700 }}>软件更新</h4>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              当前版本 <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-main)' }}>v{appVersion}</span>
              {updateResult && (
                <> · 最新发布 <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-main)' }}>v{updateResult.latest_version}</span></>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {updateError && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent-rose)' }}>
              <AlertCircle size={14} /> {updateError}
            </span>
          )}
          {updateResult && !updateError && !updateResult.update_available && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent-emerald)' }}>
              <CheckCircle2 size={14} /> 已是最新版本
            </span>
          )}
          {updateResult?.update_available && (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent-emerald)', fontWeight: 600 }}>
                <ArrowUpCircle size={14} /> 发现新版本 v{updateResult.latest_version}
              </span>
              <button className="btn btn-primary" onClick={() => openReleasePage(updateResult.release_url)}>
                <ExternalLink size={14} /> 前往下载
              </button>
            </>
          )}
          <button className="btn btn-secondary" onClick={handleCheckUpdate} disabled={checking}>
            <RefreshCw size={14} style={{ animation: checking ? 'spin 1s linear infinite' : 'none' }} /> {checking ? '检查中…' : '检查更新'}
          </button>
        </div>
      </div>

      {/* LLM Providers Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Cpu size={20} style={{ color: 'var(--accent-cyan)' }} /> LLM Provider 服务商接入 (`list_providers`)
        </h3>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus size={16} /> 添加 LLM Provider
        </button>
      </div>

      {/* Providers Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
        {providers.map(p => {
          const models: string[] = safeParse<string[]>(p.models) ?? [];
          const confirming = confirmDeleteId === p.id;

          return (
            <div key={p.id} className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div>
                  <h4 style={{ fontSize: 15, fontWeight: 700 }}>{p.name}</h4>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                    {p.base_url}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: 6 }}
                    onClick={() => openEdit(p)}
                    title="编辑 Provider"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{
                      padding: 6,
                      color: confirming ? '#fff' : 'var(--accent-rose)',
                      background: confirming ? 'var(--accent-rose)' : undefined,
                      borderColor: confirming ? 'var(--accent-rose)' : undefined,
                    }}
                    onClick={() => {
                      if (confirming) {
                        setConfirmDeleteId(null);
                        deleteProvider(p.id);
                      } else {
                        setConfirmDeleteId(p.id);
                      }
                    }}
                    title={confirming ? '再次点击确认删除' : '删除 Provider'}
                  >
                    <Trash2 size={14} /> {confirming ? '确认删除?' : ''}
                  </button>
                </div>
              </div>

              {/* API Key 状态(密钥只存后端,前端永远只见掩码) */}
              <div style={{ background: 'var(--code-bg)', padding: 8, borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, border: '1px solid var(--border-color)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-cyan)' }}>
                  {p.has_key ? '••••••••••••••••••••' : '(未设置 API Key)'}
                </span>
                <span style={{ fontSize: 10, color: p.has_key ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>
                  {p.has_key ? '已配置' : '缺少 Key'}
                </span>
              </div>

              {/* Default Model */}
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                默认模型: <strong style={{ color: 'var(--text-main)' }}>{p.default_model || '未设置'}</strong>
              </div>

              {/* Supported Models */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 'auto' }}>
                {models.map(m => (
                  <span key={m} style={{ background: 'var(--chip-bg)', color: 'var(--accent-purple)', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                    {m}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Provider 新建/编辑弹窗 */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
              {isEditing ? '编辑 LLM Provider 服务商' : '添加 LLM Provider 服务商'}
            </h3>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Vault 已启用但锁定:保存 API Key 会失败,强提示 */}
              {isVaultInitialized && !isVaultUnlocked && (!isEditing || formData.api_key) && (
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
                  <span>请先解锁 Vault 才能保存 API key</span>
                </div>
              )}
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>服务商名称</label>
                <input
                  className="input-field"
                  placeholder="e.g. DeepSeek Official"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Base URL API 地址</label>
                <input
                  className="input-field"
                  placeholder="https://api.deepseek.com/v1"
                  value={formData.base_url}
                  onChange={e => setFormData({ ...formData, base_url: e.target.value })}
                  required
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {isEditing ? 'API Key (留空保持不变)' : 'API Key (明文输入，将由 Vault 加密保存)'}
                </label>
                <input
                  type="password"
                  className="input-field"
                  placeholder={isEditing && editingProvider?.has_key ? '已设置(留空保持不变)' : 'sk-...'}
                  value={formData.api_key}
                  onChange={e => setFormData({ ...formData, api_key: e.target.value })}
                  required={!isEditing}
                />
                {isEditing && editingProvider?.has_key && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                    已设置 API Key。留空保持不变;输入新值则覆盖旧 Key。
                  </div>
                )}
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>默认模型</label>
                <input
                  className="input-field"
                  value={formData.default_model || ''}
                  onChange={e => setFormData({ ...formData, default_model: e.target.value })}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)} disabled={saving}>取消</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? '保存中…' : isEditing ? '保存修改' : '保存 Provider'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
