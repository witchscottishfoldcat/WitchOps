import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  Server, ServerInput, AuditLog, AuditFilter, Skill, QuickAction, QuickActionStep, Doc,
  ProviderSummary, ProviderInput, Container, ContainerAction, Service, ServerMetrics,
  DirEntry, ExecuteResult
} from '../types/backend';
import * as ipc from '../lib/ipc';
import type { AgentSessionInfo } from '../lib/ipc';

export interface TerminalTab {
  id: string;          // 前端 tab id(等于后端 terminal_id)
  serverId: number;
  serverName: string;
  title: string;
}

export interface AgentProposal {
  id: string;
  command: string;
  tool_name: string;
  server_id: number;
  approved?: boolean;
  status?: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'rejected';
  result?: ExecuteResult;
  safe_to_run?: boolean;
  /** 原始工具调用(供执行后回填模型上下文) */
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  /** 本轮还有多少个工具调用未列出(当前仅支持审批第一个) */
  droppedToolCalls?: number;
}

export interface AgentMessage {
  id: string;
  sender: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  proposal?: AgentProposal;
  streaming?: boolean;
}

/** 待人工确认的快捷指令执行(审批流) */
export interface PendingQuickAction {
  actionId: string;
  serverId: number;
  serverName: string;
  actionName: string;
  actionUpdatedAt: string;
  /** 将要执行的命令列表(含是否需要单独确认的标记) */
  commands: { value: string; needsConfirm: boolean }[];
}

interface AppContextType {
  // Vault
  isVaultInitialized: boolean;
  isVaultUnlocked: boolean;
  unlockVault: (pass: string) => Promise<boolean>;
  lockVault: () => Promise<void>;
  setupVault: (pass: string) => Promise<boolean>;
  recoverVault: (pass: string) => Promise<boolean>;
  resetVault: () => Promise<boolean>;

  // Theme
  theme: string;
  setTheme: (t: string) => void;

  // Sidebar
  isSidebarCollapsed: boolean;
  toggleSidebar: () => void;

  // View / Server
  activeView: string;
  setActiveView: (view: string) => void;
  activeServerId: number | null;
  setActiveServerId: (id: number | null) => void;

  // Host Key
  pendingHostKey: { serverId: number; fingerprint: string } | null;
  confirmHostKey: () => Promise<void>;
  cancelHostKey: () => Promise<void>;

  // Servers
  servers: Server[];
  connectedServerIds: Set<number>;
  refreshServers: () => Promise<void>;
  /** 连接服务器。返回是否可立即使用:
   *  - true  已连接(含指纹已确认)
   *  - false 触发首连指纹确认流程(等待用户确认),或连接失败(错误已 toast)
   */
  connectServer: (id: number) => Promise<boolean>;
  disconnectServer: (id: number) => Promise<void>;
  addServer: (input: ServerInput) => Promise<void>;
  updateServer: (id: number, input: ServerInput) => Promise<void>;
  deleteServer: (id: number) => Promise<void>;

  // Terminals
  terminalTabs: TerminalTab[];
  activeTerminalId: string | null;
  setActiveTerminalId: (id: string | null) => void;
  openTerminal: (serverId: number, cols?: number, rows?: number) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;

  // Audit
  auditLogs: AuditLog[];
  auditStats: { total: number; success: number; failed: number; unknown: number; pending: number };
  refreshAuditLogs: (filter?: AuditFilter) => Promise<void>;
  refreshAuditStats: () => Promise<void>;

  // Skills
  skills: Skill[];
  refreshSkills: () => Promise<void>;
  upsertSkill: (skill: Skill) => Promise<void>;
  toggleSkill: (id: string, enabled: boolean) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;

  // Quick Actions
  quickActions: QuickAction[];
  refreshQuickActions: () => Promise<void>;
  upsertQuickAction: (action: QuickAction) => Promise<void>;
  deleteQuickAction: (id: string) => Promise<void>;
  runQuickAction: (actionId: string, serverId: number) => Promise<void>;
  /** 待审批的快捷指令(需要人工确认时非空) */
  pendingQuickAction: PendingQuickAction | null;
  confirmQuickAction: () => Promise<void>;
  cancelQuickAction: () => void;

  // Docs
  docs: Doc[];
  refreshDocs: () => Promise<void>;
  upsertDoc: (doc: Doc) => Promise<void>;
  updateDocStatus: (id: string, status: Doc['status']) => Promise<void>;
  deleteDoc: (id: string) => Promise<void>;
  convertDocToSkill: (docId: string, title: string) => Promise<void>;

  // SFTP
  sftpPath: string;
  setSftpPath: (path: string) => void;
  sftpFiles: DirEntry[];
  sftpError: string | null;
  refreshSftpFiles: () => Promise<void>;
  readSftpFile: (path: string) => Promise<string | null>;
  writeSftpFile: (path: string, content: string) => Promise<void>;
  deleteSftpEntry: (path: string, isDir: boolean) => Promise<void>;
  createSftpDir: (path: string) => Promise<void>;

  // Metrics
  metrics: ServerMetrics | null;
  refreshMetrics: () => Promise<void>;

  // Containers & Services
  containers: Container[];
  refreshContainers: () => Promise<void>;
  controlContainer: (containerId: string, action: ContainerAction['action']) => Promise<void>;
  services: Service[];
  refreshServices: () => Promise<void>;
  controlService: (serviceName: string, action: string) => Promise<void>;

  // Providers
  providers: ProviderSummary[];
  refreshProviders: () => Promise<void>;
  addProvider: (input: ProviderInput) => Promise<void>;
  updateProvider: (id: string, input: ProviderInput) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;

  // Agent 会话列表(对话记忆模块用)
  agentSessions: AgentSessionInfo[];
  refreshAgentSessions: () => Promise<void>;
  deleteAgentSession: (id: string) => Promise<void>;

  // Errors
  lastError: string | null;
  clearError: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState('macos-dark');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isVaultInitialized, setIsVaultInitialized] = useState(false);
  const [isVaultUnlocked, setIsVaultUnlocked] = useState(false);
  const [activeView, setActiveView] = useState('servers');
  const [activeServerId, setActiveServerId] = useState<number | null>(null);
  const [pendingHostKey, setPendingHostKey] = useState<{ serverId: number; fingerprint: string } | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // Data
  const [servers, setServers] = useState<Server[]>([]);
  const [connectedServerIds, setConnectedServerIds] = useState<Set<number>>(new Set());
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  // 镜像最新页签列表:open/close 需要基于"当前最新"计算下一个列表,
  // 函数式更新无法在 updater 外拿到 nextTabs(用于 active 兜底),故用 ref 同步镜像
  const terminalTabsRef = useRef<TerminalTab[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditStats, setAuditStats] = useState({ total: 0, success: 0, failed: 0, unknown: 0, pending: 0 });
  const [skills, setSkills] = useState<Skill[]>([]);
  const [quickActions, setQuickActions] = useState<QuickAction[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [sftpPath, setSftpPath] = useState('/');
  const [sftpFiles, setSftpFiles] = useState<DirEntry[]>([]);
  const [sftpError, setSftpError] = useState<string | null>(null);
  const [pendingQuickAction, setPendingQuickAction] = useState<PendingQuickAction | null>(null);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSessionInfo[]>([]);

  const clearError = () => setLastError(null);

  const handleError = (e: unknown) => {
    const msg = e && typeof e === 'object' && 'message' in e ? String((e as any).message) : String(e);
    setLastError(msg);
    console.error('[Witchcat Ops]', e);
  };

  // 后台周期性任务(轮询)的错误:只记日志,不弹全局 toast(避免打扰)
  const silentError = (e: unknown) => {
    console.warn('[Witchcat Ops 后台任务]', e);
  };

  const setTheme = (t: string) => {
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
  };
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  const toggleSidebar = () => setIsSidebarCollapsed(p => !p);

  // ============ Vault ============
  const refreshVaultState = useCallback(async () => {
    try {
      const init = await ipc.vaultIsInitialized();
      setIsVaultInitialized(init);
      if (init) setIsVaultUnlocked(await ipc.vaultIsUnlocked());
    } catch (e) { handleError(e); }
  }, []);

  useEffect(() => { refreshVaultState(); }, [refreshVaultState]);

  const setupVault = async (pass: string) => {
    try { await ipc.vaultSetup(pass); await refreshVaultState(); await refreshProviders(); return true; }
    catch (e) { handleError(e); return false; }
  };
  const unlockVault = async (pass: string) => {
    try { await ipc.vaultUnlock(pass); await refreshVaultState(); await refreshProviders(); return true; }
    catch (e) { handleError(e); return false; }
  };
  const lockVault = async () => {
    try {
      await ipc.vaultLock();
      setIsVaultUnlocked(false);
      await refreshProviders();
    } catch (e) { handleError(e); }
  };
  const recoverVault = async (pass: string) => {
    try { await ipc.vaultRecover(pass); await refreshVaultState(); await refreshProviders(); return true; }
    catch (e) { handleError(e); return false; }
  };
  const resetVault = async () => {
    try { await ipc.vaultReset(); await refreshVaultState(); return true; }
    catch (e) { handleError(e); return false; }
  };

  // ============ Servers ============
  const refreshServers = useCallback(async () => {
    try {
      const list = await ipc.listServers();
      setServers(list);
      // 并行查询连接状态(串行 await 在服务器多时首屏明显变慢)
      const statuses = await Promise.all(
        list.map(s => ipc.serverConnectionStatus(s.id).catch(() => false))
      );
      const connected = new Set<number>();
      list.forEach((s, i) => { if (statuses[i]) connected.add(s.id); });
      setConnectedServerIds(connected);
    } catch (e) { handleError(e); }
  }, []);

  useEffect(() => { refreshServers(); }, [refreshServers]);

  const connectServer = async (id: number): Promise<boolean> => {
    try {
      // 已连接(且指纹已确认过)→ 直接可用
      if (connectedServerIds.has(id)) return true;

      const fp = await ipc.connectServer(id);
      const s = servers.find(x => x.id === id);
      if (s && !s.host_key_fingerprint && fp) {
        // 首连:连接已建立但指纹未经用户确认。
        // 在确认之前绝不把会话标记为可用 —— 拒绝时后端会断开,命令通道始终不可用。
        setPendingHostKey({ serverId: id, fingerprint: fp });
        return false;
      }
      setConnectedServerIds(prev => new Set([...prev, id]));
      return true;
    } catch (e) {
      handleError(e);
      return false;
    }
  };

  const confirmHostKey = async () => {
    if (!pendingHostKey) return;
    const serverId = pendingHostKey.serverId;
    try {
      await ipc.confirmHostKey(serverId, pendingHostKey.fingerprint);
      setConnectedServerIds(prev => new Set([...prev, serverId]));
      setPendingHostKey(null);
      await refreshServers();
    } catch (e) { handleError(e); }
  };

  // 用户拒绝指纹确认:必须真正断开后端连接(否则未验证的会话仍可被后续命令使用)
  const cancelHostKey = async () => {
    if (!pendingHostKey) return;
    const serverId = pendingHostKey.serverId;
    setPendingHostKey(null);
    try {
      await ipc.disconnectServer(serverId);
      setConnectedServerIds(prev => { const n = new Set(prev); n.delete(serverId); return n; });
    } catch (e) { handleError(e); }
  };

  const disconnectServer = async (id: number) => {
    try {
      await ipc.disconnectServer(id);
      setConnectedServerIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    } catch (e) { handleError(e); }
  };

  const addServer = async (input: ServerInput) => {
    try { await ipc.createServer(input); await refreshServers(); } catch (e) { handleError(e); }
  };
  const updateServer = async (id: number, input: ServerInput) => {
    try { await ipc.updateServer(id, input); await refreshServers(); } catch (e) { handleError(e); }
  };
  const deleteServer = async (id: number) => {
    try { await ipc.deleteServer(id); await refreshServers(); } catch (e) { handleError(e); }
  };

  // ============ Terminals ============
  const openTerminal = async (serverId: number, cols?: number, rows?: number) => {
    try {
      const s = servers.find(x => x.id === serverId);
      if (!s) return;
      if (!connectedServerIds.has(serverId)) {
        const ok = await connectServer(serverId);
        // 首连指纹待确认(或连接失败):不继续开 PTY,等用户确认后再打开
        if (!ok) return;
      }

      // 预生成 terminal_id,先注册监听缓冲输出,再开 PTY
      // (解决时序:后端开 PTY 立即推数据,若前端监听未建立会丢初始输出)
      const termId = `term_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
      ipc.frontendLog(`openTerminal 开始 id=${termId.slice(0, 16)} server=${serverId}`);
      await ipc.beginTerminalBuffer(termId);
      try {
        await ipc.terminalOpen(serverId, cols ?? 80, rows ?? 24, termId);
      } catch (e) {
        // 开 PTY 失败:必须回收已注册的缓冲监听,否则每次失败都泄漏一个事件监听器
        ipc.disposeTerminalBuffer(termId);
        throw e;
      }
      ipc.frontendLog(`openTerminal PTY 已开 id=${termId.slice(0, 16)}`);

      const tab: TerminalTab = {
        id: termId, serverId, serverName: s.name,
        title: `${s.name} (${s.host})`,
      };
      const next = [...terminalTabsRef.current, tab];
      terminalTabsRef.current = next;
      setTerminalTabs(next);
      setActiveTerminalId(termId);
      setActiveView('terminal');
    } catch (e) { handleError(e); }
  };

  const closeTerminal = async (id: string) => {
    try { await ipc.terminalClose(id); } catch (e) { console.warn('[Witchcat Ops] 关闭终端失败', e); }
    ipc.disposeTerminalBuffer(id);
    // 基于 ref 镜像同步计算:连续快速关闭多个页签时,闭包里的 terminalTabs 已过期,
    // ref 始终是最新列表,每次都能正确移除(否则会留下 xterm 已销毁的幽灵页签)。
    // active 用函数式更新兜底:关闭的是当前页签时切到剩余第一个
    const nextTabs = terminalTabsRef.current.filter(t => t.id !== id);
    terminalTabsRef.current = nextTabs;
    setTerminalTabs(nextTabs);
    setActiveTerminalId(prev => (prev === id ? nextTabs[0]?.id ?? null : prev));
  };

  // ============ Audit ============
  const refreshAuditLogs = useCallback(async (filter?: AuditFilter) => {
    try { setAuditLogs(await ipc.queryAuditLogs(filter ?? {})); } catch (e) { handleError(e); }
  }, []);
  const refreshAuditStats = useCallback(async () => {
    try { setAuditStats(await ipc.auditStats()); } catch (e) { handleError(e); }
  }, []);

  useEffect(() => { refreshAuditLogs(); refreshAuditStats(); }, [refreshAuditLogs, refreshAuditStats]);

  // ============ Skills ============
  const refreshSkills = useCallback(async () => {
    try { setSkills(await ipc.listSkills()); } catch (e) { handleError(e); }
  }, []);
  useEffect(() => { refreshSkills(); }, [refreshSkills]);

  const upsertSkill = async (skill: Skill) => {
    try { await ipc.upsertSkill(skill); await refreshSkills(); } catch (e) { handleError(e); }
  };
  const toggleSkill = async (id: string, enabled: boolean) => {
    try { await ipc.toggleSkill(id, enabled); await refreshSkills(); } catch (e) { handleError(e); }
  };
  const deleteSkill = async (id: string) => {
    try { await ipc.deleteSkill(id); await refreshSkills(); } catch (e) { handleError(e); }
  };

  // ============ Quick Actions ============
  const refreshQuickActions = useCallback(async () => {
    try { setQuickActions(await ipc.listQuickActions()); } catch (e) { handleError(e); }
  }, []);
  useEffect(() => { refreshQuickActions(); }, [refreshQuickActions]);

  const upsertQuickAction = async (action: QuickAction) => {
    try { await ipc.upsertQuickAction(action); await refreshQuickActions(); } catch (e) { handleError(e); }
  };
  const deleteQuickAction = async (id: string) => {
    try { await ipc.deleteQuickAction(id); await refreshQuickActions(); } catch (e) { handleError(e); }
  };

  const executeQuickActionOnBackend = async (
    qa: QuickAction,
    serverId: number,
    userConfirmed: boolean,
  ) => {
    try {
      const result = await ipc.executeQuickAction(qa.id, serverId, qa.updated_at, userConfirmed);
      await Promise.all([refreshAuditLogs(), refreshAuditStats()]);
      if (!result.success) {
        const failed = result.steps[result.steps.length - 1];
        handleError(new Error(
          `快捷指令 "${qa.name}" 在第 ${(result.stopped_at ?? 0) + 1} 步停止（${failed?.kind ?? 'command'} 退出码 ${failed?.exit_code ?? '未知'}）`
        ));
      }
    } catch (e) {
      handleError(e);
    }
  };

  const runQuickAction = async (actionId: string, serverId: number) => {
    const qa = quickActions.find(a => a.id === actionId);
    if (!qa) return;
    const server = servers.find(s => s.id === serverId);

    let steps: QuickActionStep[];
    try {
      steps = JSON.parse(qa.steps) as QuickActionStep[];
    } catch {
      handleError(new Error(`快捷指令 "${qa.name}" 的 steps 不是合法 JSON,无法执行`));
      return;
    }
    const commands = steps
      .filter(s => s.type === 'command' && s.value.trim())
      .map(s => ({ value: s.value, needsConfirm: !!s.confirm }));
    if (commands.length === 0) {
      handleError(new Error(`快捷指令 "${qa.name}" 没有可执行的命令步骤`));
      return;
    }

    // 审批策略(修复:always_ask 必须弹确认,审计只在实际批准后写):
    // - always_approve 且没有任何步骤标 confirm → 自动核准(policy:auto_review)
    // - 其余 → 弹确认框,用户批准后才执行(approved_by = user:quick_action)
    const autoApprove = qa.approval === 'always_approve' && !commands.some(c => c.needsConfirm);
    if (autoApprove) {
      await executeQuickActionOnBackend(qa, serverId, false);
    } else {
      setPendingQuickAction({
        actionId,
        serverId,
        serverName: server?.name ?? `#${serverId}`,
        actionName: qa.name,
        actionUpdatedAt: qa.updated_at,
        commands,
      });
    }
  };

  const confirmQuickAction = async () => {
    if (!pendingQuickAction) return;
    const { actionId, serverId, actionUpdatedAt } = pendingQuickAction;
    const qa = quickActions.find(a => a.id === actionId);
    setPendingQuickAction(null);
    if (!qa) return;
    await executeQuickActionOnBackend({ ...qa, updated_at: actionUpdatedAt }, serverId, true);
  };

  const cancelQuickAction = () => setPendingQuickAction(null);

  // ============ Docs ============
  const refreshDocs = useCallback(async () => {
    try { setDocs(await ipc.listDocs()); } catch (e) { handleError(e); }
  }, []);
  useEffect(() => { refreshDocs(); }, [refreshDocs]);

  const upsertDoc = async (doc: Doc) => {
    try { await ipc.upsertDoc(doc); await refreshDocs(); } catch (e) { handleError(e); }
  };
  const updateDocStatus = async (id: string, status: Doc['status']) => {
    try { await ipc.updateDocStatus(id, status); await refreshDocs(); } catch (e) { handleError(e); }
  };
  const deleteDoc = async (id: string) => {
    try { await ipc.deleteDoc(id); await refreshDocs(); } catch (e) { handleError(e); }
  };
  const convertDocToSkill = async (docId: string, title: string) => {
    try {
      await ipc.docToSkill(docId, `skill_${docId}`, title);
      await refreshSkills();
      setActiveView('skills');
    } catch (e) { handleError(e); }
  };

  // ============ SFTP ============
  // 目录请求代际:快速切换目录/服务器时,过期响应不得覆盖新数据
  const sftpSeqRef = useRef(0);
  const refreshSftpFiles = useCallback(async () => {
    // 未连接不发请求(否则启动/未连接时必弹"服务器未连接")
    if (!activeServerId || !connectedServerIds.has(activeServerId)) return;
    const seq = ++sftpSeqRef.current;
    // 目录导航是用户主动操作,失败必须可见(持久错误条 + toast)
    try {
      const files = await ipc.sftpListDir(activeServerId, sftpPath);
      if (seq !== sftpSeqRef.current) return; // 过期响应,丢弃
      setSftpFiles(files);
      setSftpError(null);
    } catch (e) {
      if (seq !== sftpSeqRef.current) return;
      const msg = typeof e === 'string' ? e : (e as { message?: string })?.message ?? String(e);
      setSftpFiles([]);
      setSftpError(msg);
      handleError(e);
    }
  }, [activeServerId, sftpPath, connectedServerIds]);
  useEffect(() => { refreshSftpFiles(); }, [refreshSftpFiles]);

  // 切换服务器后路径重置到根目录(避免在 B 服务器访问 A 服务器的路径)
  const prevSftpServerRef = useRef(activeServerId);
  useEffect(() => {
    if (prevSftpServerRef.current !== activeServerId) {
      prevSftpServerRef.current = activeServerId;
      setSftpPath('/');
    }
  }, [activeServerId]);

  const readSftpFile = async (path: string): Promise<string | null> => {
    if (!activeServerId) return null;
    try { return await ipc.sftpReadFile(activeServerId, path); }
    catch (e) { handleError(e); return null; }
  };
  const writeSftpFile = async (path: string, content: string) => {
    if (!activeServerId) throw new Error('未选择服务器');
    try {
      await ipc.sftpWriteFile(activeServerId, path, content);
      await refreshSftpFiles();
    } catch (e) { handleError(e); throw e; }
  };
  const deleteSftpEntry = async (path: string, isDir: boolean) => {
    if (!activeServerId) return;
    try {
      if (isDir) await ipc.sftpRmdir(activeServerId, path);
      else await ipc.sftpDeleteFile(activeServerId, path);
      await refreshSftpFiles();
    } catch (e) { handleError(e); }
  };
  const createSftpDir = async (path: string) => {
    if (!activeServerId) return;
    try { await ipc.sftpMkdir(activeServerId, path); await refreshSftpFiles(); }
    catch (e) { handleError(e); }
  };

  // ============ Metrics ============
  // 请求代际:5 秒轮询可能与上一轮重叠,旧响应后到会覆盖新数据(数值回跳)
  const metricsSeqRef = useRef(0);
  const refreshMetrics = useCallback(async () => {
    // 未连接不发请求(避免启动时无意义的后端报错)
    if (!activeServerId || !connectedServerIds.has(activeServerId)) return;
    const seq = ++metricsSeqRef.current;
    // 后台轮询:失败静默(只记日志),不弹全局错误
    try {
      const m = await ipc.getMetrics(activeServerId);
      if (seq === metricsSeqRef.current) setMetrics(m);
    } catch (e) { silentError(e); }
  }, [activeServerId, connectedServerIds]);
  useEffect(() => {
    refreshMetrics();
    const t = setInterval(refreshMetrics, 5000); // 每 5 秒刷新
    return () => clearInterval(t);
  }, [refreshMetrics]);

  // ============ Containers & Services ============
  // 后台自动刷新:失败静默;用户主动操作(controlContainer/controlService):失败弹提示
  const containersSeqRef = useRef(0);
  const refreshContainers = useCallback(async () => {
    if (!activeServerId || !connectedServerIds.has(activeServerId)) return;
    const seq = ++containersSeqRef.current;
    try {
      const list = await ipc.listContainers(activeServerId);
      if (seq === containersSeqRef.current) setContainers(list);
    } catch (e) { silentError(e); }
  }, [activeServerId, connectedServerIds]);
  useEffect(() => { refreshContainers(); }, [refreshContainers]);

  const controlContainer = async (containerId: string, action: ContainerAction['action']) => {
    if (!activeServerId) return;
    try {
      await ipc.controlContainer(activeServerId, { container_id: containerId, action });
      await refreshContainers();
    } catch (e) { handleError(e); }
  };

  const servicesSeqRef = useRef(0);
  const refreshServices = useCallback(async () => {
    if (!activeServerId || !connectedServerIds.has(activeServerId)) return;
    const seq = ++servicesSeqRef.current;
    try {
      const list = await ipc.listServices(activeServerId);
      if (seq === servicesSeqRef.current) setServices(list);
    } catch (e) { silentError(e); }
  }, [activeServerId, connectedServerIds]);
  useEffect(() => { refreshServices(); }, [refreshServices]);

  const controlService = async (serviceName: string, action: string) => {
    if (!activeServerId) return;
    try {
      await ipc.controlService(activeServerId, serviceName, action);
      await refreshServices();
    } catch (e) { handleError(e); }
  };

  // ============ Providers ============
  const refreshProviders = useCallback(async () => {
    try { setProviders(await ipc.listProviders()); } catch (e) { handleError(e); }
  }, []);
  useEffect(() => { refreshProviders(); }, [refreshProviders]);

  const addProvider = async (input: ProviderInput) => {
    try { await ipc.createProvider(input); await refreshProviders(); } catch (e) { handleError(e); }
  };
  const updateProvider = async (id: string, input: ProviderInput) => {
    try { await ipc.updateProvider(id, input); await refreshProviders(); } catch (e) { handleError(e); }
  };
  const deleteProvider = async (id: string) => {
    try { await ipc.deleteProvider(id); await refreshProviders(); } catch (e) { handleError(e); }
  };

  // ============ Agent Sessions ============
  const refreshAgentSessions = useCallback(async () => {
    try { setAgentSessions(await ipc.listAgentSessions()); } catch (e) { handleError(e); }
  }, []);
  useEffect(() => { refreshAgentSessions(); }, [refreshAgentSessions]);

  const deleteAgentSession = async (id: string) => {
    try { await ipc.deleteAgentSession(id); await refreshAgentSessions(); } catch (e) { handleError(e); }
  };

  return (
    <AppContext.Provider value={{
      theme, setTheme, isSidebarCollapsed, toggleSidebar,
      isVaultInitialized, isVaultUnlocked, unlockVault, lockVault, setupVault,
      recoverVault, resetVault,
      activeView, setActiveView, activeServerId, setActiveServerId,
      pendingHostKey, confirmHostKey, cancelHostKey,
      servers, connectedServerIds, refreshServers, connectServer, disconnectServer,
      addServer, updateServer, deleteServer,
      terminalTabs, activeTerminalId, setActiveTerminalId, openTerminal, closeTerminal,
      auditLogs, auditStats, refreshAuditLogs, refreshAuditStats,
      skills, refreshSkills, upsertSkill, toggleSkill, deleteSkill,
      quickActions, refreshQuickActions, upsertQuickAction, deleteQuickAction, runQuickAction,
      pendingQuickAction, confirmQuickAction, cancelQuickAction,
      docs, refreshDocs, upsertDoc, updateDocStatus, deleteDoc, convertDocToSkill,
      sftpPath, setSftpPath, sftpFiles, sftpError, refreshSftpFiles, readSftpFile, writeSftpFile,
      deleteSftpEntry, createSftpDir,
      metrics, refreshMetrics,
      containers, refreshContainers, controlContainer,
      services, refreshServices, controlService,
      providers, refreshProviders, addProvider, updateProvider, deleteProvider,
      agentSessions, refreshAgentSessions, deleteAgentSession,
      lastError, clearError,
    }}>
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
};
