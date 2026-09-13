import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { Lock, Unlock, Server, Bot, Terminal, Search, Palette, Moon, Sun, Heart, Zap, X, Minus, Plus } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { CustomSelect } from './CustomSelect';

// 纯 Web 预览环境(无 Tauri 注入)下 getCurrentWindow 会同步抛错,
// 捕获后降级为 null:窗口控制按钮变成 no-op,不影响页面渲染与设计预览。
const appWindow = (() => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
})();

export const Header: React.FC = () => {
  const {
    isVaultUnlocked, isVaultInitialized, lockVault, servers, activeServerId, setActiveServerId,
    connectedServerIds, setActiveView, theme, setTheme
  } = useApp();

  // 版本徽标:从 tauri 运行时读取,与 tauri.conf.json 保持一致(浏览器环境回退 'dev')
  const [appVersion, setAppVersion] = useState<string>('dev');
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
      .catch(() => { /* 非 Tauri 环境(纯 Web 预览)时保持 dev */ });
    return () => { cancelled = true; };
  }, []);

  const activeServer = servers.find(s => s.id === activeServerId);

  const themeOptions = [
    { value: 'macos-dark', label: 'macOS 黑夜', icon: <Moon size={13} /> },
    { value: 'macos-light', label: 'macOS 白天', icon: <Sun size={13} /> },
    { value: 'bilibili-pink', label: 'Bilibili 粉色', icon: <Heart size={13} style={{ color: 'var(--apple-pink)' }} /> },
    { value: 'cyber-neon', label: '赛博暗黑', icon: <Zap size={13} /> },
    { value: 'monokai-pro', label: 'Monokai 极客', icon: <Palette size={13} /> },
  ];

  const serverOptions = servers.map(s => ({
    value: String(s.id),
    label: `${s.name} (${s.host})`,
    icon: (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: connectedServerIds.has(s.id) ? 'var(--apple-green)' : 'var(--apple-text-dim)',
          display: 'inline-block',
        }}
      />
    )
  }));

  return (
    <header className="header-bar" data-tauri-drag-region>
      <div className="header-left">
        {/* macOS 三键(无边框窗口,接管窗口控制) */}
        <div className="mac-traffic-lights">
          <button className="traffic-light traffic-light-close" title="关闭" onClick={() => appWindow?.close()}>
            <X size={9} strokeWidth={3} />
          </button>
          <button className="traffic-light traffic-light-minimize" title="最小化" onClick={() => appWindow?.minimize()}>
            <Minus size={9} strokeWidth={3} />
          </button>
          <button className="traffic-light traffic-light-maximize" title="最大化/还原" onClick={() => appWindow?.toggleMaximize()}>
            <Plus size={9} strokeWidth={3} />
          </button>
        </div>

        <div className="brand-logo" data-tauri-drag-region>
          <img src="/logo.png" alt="Witchcat" style={{ width: 22, height: 22, borderRadius: 6 }} draggable={false} />
          <span>Witchcat<span style={{ color: 'var(--apple-purple)', marginLeft: 2 }}>Ops</span></span>
          <span style={{ fontSize: 10, background: 'rgba(191, 90, 242, 0.15)', color: 'var(--apple-purple)', padding: '1px 6px', borderRadius: 10, marginLeft: 4, fontWeight: 600 }}>
            v{appVersion}
          </span>
        </div>

        <div style={{ width: 1, height: 20, background: 'var(--apple-border)', margin: '0 4px' }} />

        {/* Custom Server Selector Dropdown */}
        <CustomSelect
          options={serverOptions}
          value={String(activeServerId || 1)}
          onChange={(val) => setActiveServerId(Number(val))}
          icon={<Server size={14} style={{ color: activeServer ? 'var(--apple-green)' : 'var(--apple-text-muted)' }} />}
        />
      </div>

      <div className="header-right">
        {/* Global Search Bar */}
        <div style={{ position: 'relative', width: 180 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--apple-text-dim)' }} />
          <input
            className="input-field"
            placeholder="搜索(开发中)"
            style={{ paddingLeft: 28, fontSize: 12, height: 30, opacity: 0.5 }}
            disabled
          />
        </div>

        {/* Custom Multi-Theme Palette Selector Popover */}
        <CustomSelect
          options={themeOptions}
          value={theme}
          onChange={(val) => setTheme(val)}
          icon={<Palette size={14} style={{ color: 'var(--apple-blue)' }} />}
        />

        {/* Agent Quick Entry */}
        <button
          className="btn btn-secondary"
          onClick={() => setActiveView('agent')}
          style={{ height: 30, fontSize: 12 }}
        >
          <Bot size={14} style={{ color: 'var(--apple-purple)' }} />
          <span>Agent</span>
        </button>

        {/* Terminal Quick Entry */}
        <button
          className="btn btn-secondary"
          onClick={() => setActiveView('terminal')}
          style={{ height: 30, fontSize: 12 }}
        >
          <Terminal size={14} style={{ color: 'var(--apple-cyan)' }} />
          <span>PTY Stream</span>
        </button>

        {/* Vault 状态徽标:未启用(灰)/ 已解锁(绿)/ 已锁定(红) */}
        <button
          className={`btn ${!isVaultInitialized ? 'btn-secondary' : isVaultUnlocked ? 'btn-success' : 'btn-danger'}`}
          onClick={() => isVaultUnlocked ? lockVault() : setActiveView('settings')}
          style={{ height: 30, fontSize: 12 }}
          title={
            !isVaultInitialized
              ? 'Vault 未启用:敏感数据明文存于项目 data 目录,可在设置中启用加密'
              : isVaultUnlocked
                ? 'Vault 已解锁 (AES-GCM-256)'
                : 'Vault 已锁定,点击前往解锁'
          }
        >
          {isVaultUnlocked ? <Unlock size={13} /> : <Lock size={13} />}
          <span>{!isVaultInitialized ? 'Vault 未启用' : isVaultUnlocked ? 'Vault 解锁' : 'Vault 锁定'}</span>
        </button>
      </div>
    </header>
  );
};
