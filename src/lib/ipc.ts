// Witchcat Ops IPC 封装层 —— 类型安全的 invoke 封装
// 所有后端命令在这里统一封装,组件不直接调 invoke。
// 契约来源:docs/BACKEND_API.md

import { invoke as tauriInvoke, Channel } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type {
  Server, ServerInput, AuditLog, AuditFilter, Skill, QuickAction, Doc,
  ProviderSummary, ProviderInput, Container, ContainerAction, Service, ServerMetrics,
  DirEntry, ExecuteResult, AgentExecutionResult, QuickActionExecutionResult,
  ChatRequest, ChatEvent,
} from '../types/backend';

// ============ 纯 Web 预览降级 ============
//
// 无 Tauri 运行时注入(浏览器直接打开 vite dev server)时,
// tauriInvoke 会同步抛 "Cannot read properties of undefined (reading 'invoke')"。
// 这里做一层守卫:
// - 启动即触发的只读命令返回类型安全的空默认值,让预览 UI 干净渲染(不弹错误);
// - 其余命令拒绝并给出明确提示(点击功能时 toast"后端未运行")。
// 真实 Tauri 应用中 __TAURI_INTERNALS__ 始终存在,此守卫完全不影响正常行为。

/** 是否运行在 Tauri 运行时内 */
const isTauriRuntime = (): boolean =>
  typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

/** 预览模式下的只读命令默认值(类型与后端契约一致) */
const PREVIEW_DEFAULTS: Record<string, unknown> = {
  vault_is_initialized: false,
  vault_is_unlocked: false,
  list_servers: [] as Server[],
  list_skills: [] as Skill[],
  list_enabled_skills: [] as Skill[],
  list_quick_actions: [] as QuickAction[],
  list_docs: [] as Doc[],
  list_providers: [] as ProviderSummary[],
  list_agent_sessions: [] as unknown[],
  query_audit_logs: [] as AuditLog[],
  audit_stats: { total: 0, success: 0, failed: 0 },
  list_containers: [] as Container[],
  list_services: [] as Service[],
  sftp_list_dir: [] as DirEntry[],
  server_connection_status: false,
  get_metrics: {
    cpu_usage: 0, mem_total: 0, mem_used: 0, mem_available: 0,
    swap_total: 0, swap_used: 0, load_1: 0, load_5: 0, load_15: 0,
    uptime_seconds: 0, disks: [],
  } as ServerMetrics,
};

/** invoke 的守卫封装:预览模式下不触达 tauriInvoke(避免同步抛错) */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    if (cmd in PREVIEW_DEFAULTS) {
      return Promise.resolve(PREVIEW_DEFAULTS[cmd] as T);
    }
    return Promise.reject(new Error(`后端未运行(纯 Web 预览):IPC '${cmd}' 不可用`));
  }
  return tauriInvoke<T>(cmd, args);
}

// ============ 凭证库 ============
export const vaultIsInitialized = () => invoke<boolean>('vault_is_initialized');
export const vaultSetup = (masterPassword: string) =>
  invoke<void>('vault_setup', { masterPassword });
export const vaultUnlock = (masterPassword: string) =>
  invoke<void>('vault_unlock', { masterPassword });
export const vaultLock = () => invoke<void>('vault_lock');
export const vaultIsUnlocked = () => invoke<boolean>('vault_is_unlocked');
/** 忘记密码:用本机钥匙串备份重设主密码(凭证全保留) */
export const vaultRecover = (newPassword: string) =>
  invoke<void>('vault_recover', { newPassword });
/** 彻底重置 Vault(清空所有已存凭证,不可恢复) */
export const vaultReset = () => invoke<void>('vault_reset');

// ============ 服务器 ============
export const listServers = () => invoke<Server[]>('list_servers');
export const getServer = (id: number) => invoke<Server>('get_server', { id });
export const createServer = (input: ServerInput) => invoke<number>('create_server', { input });
export const updateServer = (id: number, input: ServerInput) =>
  invoke<void>('update_server', { id, input });
export const deleteServer = (id: number) => invoke<void>('delete_server', { id });
export const connectServer = (id: number) => invoke<string>('connect_server', { id });
export const confirmHostKey = (id: number, fingerprint: string) =>
  invoke<void>('confirm_host_key', { id, fingerprint });
export const disconnectServer = (id: number) => invoke<void>('disconnect_server', { id });
export const serverConnectionStatus = (id: number) =>
  invoke<boolean>('server_connection_status', { id });
// ============ 审计日志 ============
export const queryAuditLogs = (filter: AuditFilter) =>
  invoke<AuditLog[]>('query_audit_logs', { filter });
export const getSessionAuditLogs = (sessionId: string) =>
  invoke<AuditLog[]>('get_session_audit_logs', { sessionId });
export const auditStats = () =>
  invoke<{ total: number; success: number; failed: number; unknown: number; pending: number }>('audit_stats');

// ============ Skills ============
export const listSkills = () => invoke<Skill[]>('list_skills');
export const listEnabledSkills = () => invoke<Skill[]>('list_enabled_skills');
export const getSkill = (id: string) => invoke<Skill>('get_skill', { id });
export const upsertSkill = (skill: Skill) => invoke<void>('upsert_skill', { skill });
export const deleteSkill = (id: string) => invoke<void>('delete_skill', { id });
export const toggleSkill = (id: string, enabled: boolean) =>
  invoke<void>('toggle_skill', { id, enabled });

// ============ 快捷指令 ============
export const listQuickActions = () => invoke<QuickAction[]>('list_quick_actions');
export const upsertQuickAction = (action: QuickAction) =>
  invoke<void>('upsert_quick_action', { action });
export const deleteQuickAction = (id: string) => invoke<void>('delete_quick_action', { id });
export const executeQuickAction = (
  actionId: string,
  serverId: number,
  expectedUpdatedAt: string,
  userConfirmed: boolean,
) => invoke<QuickActionExecutionResult>('execute_quick_action', {
  actionId, serverId, expectedUpdatedAt, userConfirmed,
});

// ============ 文档 ============
export const listDocs = () => invoke<Doc[]>('list_docs');
export const getDoc = (id: string) => invoke<Doc>('get_doc', { id });
export const upsertDoc = (doc: Doc) => invoke<void>('upsert_doc', { doc });
export const updateDocStatus = (id: string, status: Doc['status']) =>
  invoke<void>('update_doc_status', { id, status });
export const deleteDoc = (id: string) => invoke<void>('delete_doc', { id });
export const docToSkill = (docId: string, skillId: string, title: string) =>
  invoke<void>('doc_to_skill', { docId, skillId, title });

// ============ Providers ============
export const listProviders = () => invoke<ProviderSummary[]>('list_providers');
export const getProvider = (id: string) =>
  invoke<ProviderSummary>('get_provider', { id });
export const createProvider = (input: ProviderInput) =>
  invoke<string>('create_provider', { input });
export const updateProvider = (id: string, input: ProviderInput) =>
  invoke<void>('update_provider', { id, input });
export const deleteProvider = (id: string) => invoke<void>('delete_provider', { id });

// ============ Agent LLM 调用代理(后端直连 provider,key 不出后端) ============
/** 发起流式 LLM 调用;事件经 Channel 推送,Promise 在命令受理后即 resolve */
export const agentChat = (
  request: ChatRequest,
  onEvent: (event: ChatEvent) => void
): Promise<void> => {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error('后端未运行(纯 Web 预览):Agent 对话不可用'));
  }
  const out = new Channel<ChatEvent>();
  out.onmessage = (event) => onEvent(event);
  return invoke('agent_chat', { request, out });
};

/** 取消指定 request 的流式调用(后端断开连接,不再发 Done) */
export const agentChatCancel = (requestId: string) =>
  invoke<void>('agent_chat_cancel', { requestId });

// ============ SFTP ============
export const sftpListDir = (serverId: number, path: string) =>
  invoke<DirEntry[]>('sftp_list_dir', { serverId, path });
export const sftpReadFile = (serverId: number, path: string) =>
  invoke<string>('sftp_read_file', { serverId, path });
export const sftpWriteFile = (serverId: number, path: string, content: string) =>
  invoke<void>('sftp_write_file', { serverId, path, content });
export const sftpDeleteFile = (serverId: number, path: string) =>
  invoke<void>('sftp_delete_file', { serverId, path });
export const sftpMkdir = (serverId: number, path: string) =>
  invoke<void>('sftp_mkdir', { serverId, path });
export const sftpRmdir = (serverId: number, path: string) =>
  invoke<void>('sftp_rmdir', { serverId, path });
export const sftpRename = (serverId: number, from: string, to: string) =>
  invoke<void>('sftp_rename', { serverId, from, to });
export const sftpStat = (serverId: number, path: string) =>
  invoke<{ canonical: string; exists: boolean; is_dir: boolean; size: number }>(
    'sftp_stat', { serverId, path }
  );
/** 下载远程文件到本地(后端直连 SFTP → 本地磁盘) */
export const sftpDownload = (serverId: number, remotePath: string, localPath: string) =>
  invoke<void>('sftp_download', { serverId, remotePath, localPath });
/** 上传本地文件到远程(后端直连本地磁盘 → SFTP) */
export const sftpUpload = (serverId: number, localPath: string, remotePath: string) =>
  invoke<void>('sftp_upload', { serverId, localPath, remotePath });

// ============ 监控 ============
export const getMetrics = (serverId: number) =>
  invoke<ServerMetrics>('get_metrics', { serverId });

// ============ 容器 ============
export const listContainers = (serverId: number, runtime?: string) =>
  invoke<Container[]>('list_containers', { serverId, runtime });
export const controlContainer = (serverId: number, action: ContainerAction) =>
  invoke<ExecuteResult>('control_container', { serverId, action });

// ============ systemd ============
export const listServices = (serverId: number) =>
  invoke<Service[]>('list_services', { serverId });
export const controlService = (
  serverId: number, serviceName: string, action: string, sessionId?: string
) => invoke<ExecuteResult>('control_service', { serverId, serviceName, action, sessionId });

// ============ 交互式终端流 ============
export const terminalOpen = (serverId: number, cols?: number, rows?: number, terminalId?: string) =>
  invoke<string>('terminal_open', { serverId, cols, rows, terminalId });
export const terminalInput = (terminalId: string, data: string) =>
  invoke<void>('terminal_input', { terminalId, data });
export const terminalResize = (terminalId: string, cols: number, rows: number) =>
  invoke<void>('terminal_resize', { terminalId, cols, rows });
export const terminalClose = (terminalId: string) =>
  invoke<void>('terminal_close', { terminalId });

/** 监听终端输出(base64 编码的服务器输出) */
export const onTerminalOutput = (
  terminalId: string,
  handler: (bytes: Uint8Array) => void
): Promise<UnlistenFn> =>
  listen<{ data: string }>(`terminal_output_${terminalId}`, (e) => {
    const bytes = Uint8Array.from(atob(e.payload.data), c => c.charCodeAt(0));
    handler(bytes);
  });

/** 监听终端退出 */
export const onTerminalExit = (
  terminalId: string,
  handler: (code: number) => void
): Promise<UnlistenFn> =>
  listen<{ code: number }>(`terminal_exit_${terminalId}`, (e) => {
    handler(e.payload.code);
  });

// ============ 诊断 ============
/** 前端日志桥:关键节点打到后端日志(排查用) */
export const frontendLog = (msg: string) =>
  invoke<void>('frontend_log', { msg }).catch(() => {});

// ============ Agent 会话持久化 ============
export interface StoredMessage {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  proposal?: unknown;
}
export interface AgentSessionInfo {
  id: string;
  title: string | null;
  server_ids: string | null; // JSON 数组字符串,如 "[1]"
  model: string | null;
  tool_calls_count: number;
  created_at: string;
  updated_at: string;
}
export const createAgentSession = (title?: string, serverId?: number, model?: string) =>
  invoke<string>('create_agent_session', { title, serverId, model });
export const listAgentSessions = () =>
  invoke<AgentSessionInfo[]>('list_agent_sessions');
export const loadAgentMessages = (sessionId: string) =>
  invoke<StoredMessage[]>('load_agent_messages', { sessionId });
export const appendAgentMessage = (sessionId: string, message: StoredMessage) =>
  invoke<void>('append_agent_message', { sessionId, message });
export const renameAgentSession = (id: string, title: string) =>
  invoke<void>('rename_agent_session', { id, title });
export const deleteAgentSession = (id: string) =>
  invoke<void>('delete_agent_session', { id });

// ============ Agent 提案审批状态机(服务端强制)============
// 前端只能创建提案/请求批准/请求拒绝;执行必须经 execute_agent_proposal,
// 后端校验 approved 状态后才会执行,审批上下文(source/approved_by/proposal_id)由服务端构建。
export const createAgentProposal = (
  sessionId: string | null,
  serverId: number,
  toolName: string,
  command: string | null,
  args: string | null,
) => invoke<string>('create_agent_proposal', { sessionId, serverId, toolName, command, args });
export const approveAgentProposal = (id: string) =>
  invoke<void>('approve_agent_proposal', { id });
export const rejectAgentProposal = (id: string) =>
  invoke<void>('reject_agent_proposal', { id });
export const executeAgentProposal = (id: string) =>
  invoke<AgentExecutionResult>('execute_agent_proposal', { id });

// ============ 终端输出缓冲(解决"打开时序"问题)============
//
// 问题:后端 PTY 一开就推数据,但前端 xterm 可能还没挂载好,
// 导致初始输出(shell 欢迎信息、提示符)丢失 → 终端全黑。
//
// 方案:terminal_open 前先调用 beginTerminalBuffer(id) 注册监听并缓冲输出,
// xterm 挂载后调用 attachTerminalBuffer(id, write) 回放缓冲 + 接管后续输出。

interface TermBuffer {
  chunks: Uint8Array[];       // 缓冲的输出
  writer: ((bytes: Uint8Array) => void) | null; // xterm 写入函数
  unlisten: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  exited: number | null;      // 退出码(-1=断开)
}

const termBuffers = new Map<string, TermBuffer>();

/** 缓冲上限:attach 前最多缓存 256KB,超出丢弃最旧数据(防持续大流量输出撑爆内存) */
const MAX_BUFFER_BYTES = 256 * 1024;

/** 在开 PTY 前调用:注册监听,开始缓冲输出 */
export async function beginTerminalBuffer(terminalId: string): Promise<void> {
  if (termBuffers.has(terminalId)) return;
  const buf: TermBuffer = { chunks: [], writer: null, unlisten: null, unlistenExit: null, exited: null };
  let received = 0;

  // 输出事件:有 writer 就直接写,否则进缓冲
  buf.unlisten = await listen<{ data: string }>(`terminal_output_${terminalId}`, (e) => {
    received++;
    const bytes = Uint8Array.from(atob(e.payload.data), c => c.charCodeAt(0));
    if (received <= 3) {
      frontendLog(`监听器收到 chunk #${received} (${bytes.length}B) writer=${buf.writer ? '有' : '无(进缓冲)'} id=${terminalId.slice(0, 16)}`);
    }
    if (buf.writer) {
      buf.writer(bytes);
    } else {
      // 有界缓冲:超限丢弃最旧数据
      buf.chunks.push(bytes);
      let total = 0;
      for (let i = buf.chunks.length - 1; i >= 0; i--) {
        total += buf.chunks[i].length;
        if (total > MAX_BUFFER_BYTES) {
          buf.chunks.splice(0, i); // 保留最新部分
          break;
        }
      }
    }
  });
  frontendLog(`beginTerminalBuffer 监听已注册 id=${terminalId.slice(0, 16)}`);

  // 退出事件:记录退出码(监听器必须在 dispose 时取消,否则每个终端泄漏一个监听)
  buf.unlistenExit = await listen<{ code: number }>(`terminal_exit_${terminalId}`, (e) => {
    buf.exited = e.payload.code;
    frontendLog(`收到退出事件 code=${e.payload.code} id=${terminalId.slice(0, 16)}`);
  });

  termBuffers.set(terminalId, buf);
}

/** xterm 挂载后调用:回放缓冲 + 接管后续输出 */
export function attachTerminalBuffer(
  terminalId: string,
  write: (bytes: Uint8Array) => void
): void {
  const buf = termBuffers.get(terminalId);
  if (!buf) {
    frontendLog(`attachTerminalBuffer 失败:缓冲不存在! id=${terminalId.slice(0, 16)}`);
    return;
  }
  buf.writer = write;
  const n = buf.chunks.length;
  // 回放所有缓冲的输出
  for (const chunk of buf.chunks) {
    write(chunk);
  }
  buf.chunks = [];
  frontendLog(`attachTerminalBuffer 成功,回放 ${n} 个缓冲 chunk id=${terminalId.slice(0, 16)}`);
}

/** 查询终端是否已退出(供 UI 显示断开状态) */
export function getTerminalExitCode(terminalId: string): number | null {
  return termBuffers.get(terminalId)?.exited ?? null;
}

/** 清理缓冲(关闭终端时调用) */
export function disposeTerminalBuffer(terminalId: string): void {
  const buf = termBuffers.get(terminalId);
  buf?.unlisten?.();
  buf?.unlistenExit?.();
  termBuffers.delete(terminalId);
}
