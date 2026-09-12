import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { Bot, Send, Check, X, Sparkles, Terminal, Loader2, AlertCircle, FileText, History } from 'lucide-react';
import { MarkdownText } from './MarkdownText';
import { AgentSession, loadAgentConfig, loadEnabledSkills, loadAgentServers, AgentToolCall, AgentTurn } from '../lib/agent';
import type { AgentConfig } from '../lib/agent';
import * as ipc from '../lib/ipc';
import type { AgentMessage, AgentProposal } from '../context/AppContext';
import type { ExecuteResult } from '../types/backend';

/** 只读工具:自动执行,不走人工审批(结果回传 Agent 续轮) */
const READ_ONLY_TOOLS = new Set(['get_metrics', 'read_file', 'get_skill']);

/**
 * Agent 对话面板(可复用)
 *
 * 工具分发策略:
 * - 只读工具(get_metrics / read_file / get_skill):自动执行 → 结果回传 Agent 续轮
 * - 写工具(run_command / write_file):生成提案卡片,人工审批后才执行
 */
export const AgentChatPanel: React.FC<{ compact?: boolean; sessionId?: string | null }> = ({ compact = false, sessionId = null }) => {
  const {
    skills, servers, activeServerId, providers,
    upsertDoc, refreshAgentSessions, agentSessions,
  } = useApp();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [inputMsg, setInputMsg] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [session, setSession] = useState<AgentSession | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<AgentSession | null>(null);
  const prevConfigRef = useRef<AgentConfig | null>(null);
  const turnRef = useRef<Map<string, AgentTurn>>(new Map());
  const msgIdCounter = useRef(0);
  const [showSaveDoc, setShowSaveDoc] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // messagesRef 始终镜像最新消息数组:finalize 时从这里同步读取最终内容,
  // 不依赖 setState updater(updater 必须是纯函数,且组件卸载后不会再执行)
  const messagesRef = useRef<AgentMessage[]>([]);
  // 消息写入版本号:用于检测「加载历史期间有新消息写入」,避免 load 结果覆盖新消息
  const messagesVersionRef = useRef(0);

  /** 统一的消息列表更新入口:同步维护 ref,再交给 state 触发渲染 */
  const updateMessages = useCallback((next: AgentMessage[]) => {
    messagesVersionRef.current++;
    messagesRef.current = next;
    setMessages(next);
  }, []);

  // JSONL append 串行化链:后端 append 是「写一行 JSON + 写换行」两次写操作,
  // 并发 append 会把两行交错成 {...}{...} 损坏行 → 所有 append 排队依次执行
  const appendChainRef = useRef<Promise<void>>(Promise.resolve());

  // 幂等持久化记录:消息 id → 已落盘的内容快照(JSON)。
  // 持久化策略:内容变化才 append,而不是「每个 id 至多 append 一次」。
  // 依据:后端 load 时按 id 去重且保留最后一条 → 内容变化时再次 append 会让
  // 「最终内容」胜出(例如 onDone 之后 dispatchToolCalls 又补上 proposal、
  // handleReject 更新 approved 状态);内容未变则直接跳过,绝不重复 append,
  // 同时消除了 StrictMode/重复 finalize 造成的同一消息写两遍的问题。
  const lastPersistedRef = useRef<Map<string, string>>(new Map());

  /** 持久化一条消息到后端 JSONL(进串行队列,避免并发写交错) */
  const persistMessage = useCallback((msg: AgentMessage) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const stored = {
      id: msg.id,
      sender: msg.sender,
      content: msg.content,
      timestamp: msg.timestamp,
      proposal: msg.proposal,
    };
    appendChainRef.current = appendChainRef.current
      .then(() => ipc.appendAgentMessage(sessionId, stored))
      .catch(e => ipc.frontendLog(`[AgentPanel] persist 失败: ${e}`));
  }, []);

  /** 更新消息列表,并持久化新增的消息 */
  const appendMessage = useCallback((msg: AgentMessage) => {
    updateMessages([...messagesRef.current, msg]);
    persistMessage(msg);
  }, [persistMessage, updateMessages]);

  // 唯一消息 ID(避免同毫秒冲突)
  const nextId = (prefix: string) => `${prefix}_${Date.now()}_${msgIdCounter.current++}`;

  /** 将消息最终状态持久化(从 messagesRef 同步读最终内容;内容未变则幂等跳过) */
  const finalizeMessage = useCallback((id: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const msg = messagesRef.current.find(m => m.id === id);
    if (!msg) return;
    const key = JSON.stringify([msg.content, msg.proposal ?? null]);
    if (lastPersistedRef.current.get(id) === key) return; // 与已落盘内容一致:跳过
    lastPersistedRef.current.set(id, key);
    appendChainRef.current = appendChainRef.current
      .then(() => ipc.appendAgentMessage(sessionId, {
        id: msg.id, sender: msg.sender, content: msg.content,
        timestamp: msg.timestamp, proposal: msg.proposal,
      }))
      .catch(e => console.error('[Agent] 消息持久化失败', e));
  }, []);

  /** 把仍在流式的消息按当前内容快照持久化(会话切换/面板卸载前的兜底) */
  const finalizeUnfinished = useCallback(() => {
    for (const m of messagesRef.current) {
      if (m.streaming) finalizeMessage(m.id);
    }
  }, [finalizeMessage]);

  /** 手动切换到指定会话(compact 模式用) */
  const switchSession = async (id: string) => {
    // 切换前:此时 sessionIdRef 还是旧会话,先把旧会话里仍在流式的消息
    // 按当前内容快照持久化,防止流式中途切换导致旧会话消息丢失
    finalizeUnfinished();
    sessionIdRef.current = id;
    localStorage.setItem('agent_active_session', id);
    setShowHistory(false);
    try {
      const versionAtLoad = messagesVersionRef.current;
      const stored = await ipc.loadAgentMessages(id);
      // 加载期间用户又切了别的会话,或在该会话里发出了新消息:丢弃过期结果,不覆盖
      if (sessionIdRef.current !== id) return;
      if (messagesVersionRef.current !== versionAtLoad) return;
      const restored: AgentMessage[] = stored.map(s => ({
        id: s.id,
        sender: s.sender as 'user' | 'agent' | 'system',
        content: s.content,
        timestamp: s.timestamp,
        proposal: s.proposal as AgentProposal | undefined,
      }));
      // 新会话:清空幂等记录,恢复出来的消息若被更新(如审批/拒绝)允许再次落盘
      lastPersistedRef.current.clear();
      updateMessages(restored);
      sessionRef.current?.restoreHistory(restored);
    } catch { /* */ }
  };

  // 初始化 Agent 会话
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const config = await loadAgentConfig();
        const enabledSkills = await loadEnabledSkills();
        const agentServers = await loadAgentServers();
        if (cancelled) return;
        ipc.frontendLog(`[AgentPanel ${compact ? 'compact' : 'full'}] init: config=${config ? '有' : '无'} servers=${agentServers.length} skills=${enabledSkills.length}`);
        if (!config) {
          prevConfigRef.current = null;
          sessionRef.current = null;
          setSession(null);
          return;
        }
        const prev = prevConfigRef.current;
        if (prev && prev.providerId === config.providerId && prev.model === config.model) {
          prevConfigRef.current = config;
          return;
        }
        prevConfigRef.current = config;
        const s = new AgentSession(config, agentServers, enabledSkills);
        sessionRef.current = s;
        setSession(s);
        ipc.frontendLog(`[AgentPanel ${compact ? 'compact' : 'full'}] session 已创建 model=${config.model}`);
      } catch (e) {
        if (cancelled) return;
        // IPC 失败不再抛成未处理的 Promise rejection;回到无会话状态,UI 保持可用
        console.error('[Agent] 初始化会话失败', e);
        prevConfigRef.current = null;
        sessionRef.current = null;
        setSession(null);
      }
    };
    init();
    return () => { cancelled = true; };
  }, [providers]);

  // 服务器/技能列表变化时刷新会话注入的上下文
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentServers, enabledSkills] = await Promise.all([loadAgentServers(), loadEnabledSkills()]);
        if (cancelled) return;
        sessionRef.current?.updateContext(agentServers, enabledSkills);
      } catch { /* 不打断对话 */ }
    })();
    return () => { cancelled = true; };
  }, [skills, servers]);

  // 会话切换时:加载历史消息 + 重建 LLM 上下文
  useEffect(() => {
    // compact 模式(终端右侧面板):没有传入 sessionId 时,
    // 从 localStorage 恢复上次对话,实现"打开就能看到历史"
    const effectiveSessionId = sessionId ?? localStorage.getItem('agent_active_session');
    sessionIdRef.current = effectiveSessionId;
    if (!effectiveSessionId) {
      updateMessages([]);
      return;
    }
    let cancelled = false;
    const versionAtLoad = messagesVersionRef.current;
    (async () => {
      try {
        const stored = await ipc.loadAgentMessages(effectiveSessionId);
        if (cancelled) return;
        // 竞态防护:加载期间用户已切到别的会话(sessionIdRef 被 switchSession 改掉),
        // 或已发出新消息(版本号变化)→ 丢弃过期结果,不覆盖新消息
        if (sessionIdRef.current !== effectiveSessionId) return;
        if (messagesVersionRef.current !== versionAtLoad) return;
        const restored: AgentMessage[] = stored.map(s => ({
          id: s.id,
          sender: s.sender as 'user' | 'agent' | 'system',
          content: s.content,
          timestamp: s.timestamp,
          proposal: s.proposal as AgentProposal | undefined,
        }));
        lastPersistedRef.current.clear(); // 新会话:清空幂等记录,恢复出的消息允许再次更新落盘
        updateMessages(restored);
        // 重建 LLM 上下文:让 Agent "记住"之前的对话
        sessionRef.current?.restoreHistory(restored);
      } catch (e) { console.error('[Agent] 加载历史消息失败', e); }
    })();
    return () => {
      cancelled = true;
      // 清理时机:会话切换(AgentCopilot 按 key={activeSessionId} 重挂载面板)或面板卸载。
      // 本清理先于新 effect 执行,此时 sessionIdRef 仍是旧会话 → 把旧会话尚未完成的
      // 流式消息按当前内容快照持久化。若流式稍后才完成,旧闭包里的 updateMessages
      // 仍会更新 messagesRef(ref 是普通对象,卸载后照样可写),finalizeMessage 检测到
      // 内容变化会再次落盘,后端按 id 去重取最后一条 → 最终内容胜出。
      finalizeUnfinished();
    };
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const h = (e: Event) => setInputMsg((e as CustomEvent<string>).detail);
    window.addEventListener('agent:set-input', h);
    return () => window.removeEventListener('agent:set-input', h);
  }, []);

  /** 校验 server_id 是否有效 */
  const validateServerId = (sid: unknown): number | null => {
    if (typeof sid !== 'number') return null;
    return servers.some(s => s.id === sid) ? sid : null;
  };

  /** 执行只读工具,返回结果文本(供 Agent 续轮) */
  const executeReadOnlyTool = async (call: AgentToolCall): Promise<string> => {
    // 统一错误提取:Tauri IPC 错误是 { code, message } 对象,不是 Error 实例
    const errMsg = (e: unknown): string => {
      if (e instanceof Error) return e.message;
      if (e && typeof e === 'object' && 'message' in e) return String((e as Record<string, unknown>).message);
      return String(e);
    };

    switch (call.name) {
      case 'get_metrics': {
        const sid = validateServerId(call.arguments.server_id);
        if (!sid) throw new Error('get_metrics 缺少有效的 server_id');
        try {
          const m = await ipc.getMetrics(sid);
          return JSON.stringify(m);
        } catch (e) {
          throw new Error(`获取服务器 ${sid} 指标失败(可能未连接): ${errMsg(e)}`);
        }
      }
      case 'read_file': {
        const sid = validateServerId(call.arguments.server_id);
        const path = call.arguments.path;
        if (!sid) throw new Error('read_file 缺少有效的 server_id');
        if (typeof path !== 'string') throw new Error('read_file 缺少 path 参数');
        try {
          return await ipc.sftpReadFile(sid, path);
        } catch (e) {
          throw new Error(`读取文件 ${path} 失败: ${errMsg(e)}`);
        }
      }
      case 'get_skill': {
        const id = call.arguments.id;
        if (typeof id !== 'string') throw new Error('get_skill 缺少 id 参数');
        const skill = await ipc.getSkill(id);
        return skill.content;
      }
      default:
        throw new Error(`未知只读工具: ${call.name}`);
    }
  };

  /** 将工具执行结果回传 Agent,自动续轮 */
  const continueWithResult = async (
    call: AgentToolCall,
    resultText: string,
  ) => {
    if (!sessionRef.current) return;
    const resultMsgId = nextId('msg_agent');
    updateMessages([...messagesRef.current, {
      id: resultMsgId, sender: 'agent', content: '', streaming: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }]);

    const callbacks = {
      onText: (text: string) => updateMessages(messagesRef.current.map(m => m.id === resultMsgId ? { ...m, content: text } : m)),
      onProposal: () => {},
      onDone: (turn: AgentTurn) => {
        updateMessages(messagesRef.current.map(m => m.id === resultMsgId ? {
          ...m, content: turn.text || '(分析完成)', streaming: false,
        } : m));
        // 这里不 finalize:dispatchToolCalls 会把 proposal/最终内容写入后再统一 finalize,
        // 避免同一条消息被 append 两次
        dispatchToolCalls(turn, resultMsgId);
      },
      onError: (err: Error) => {
        updateMessages(messagesRef.current.map(m => m.id === resultMsgId ? {
          ...m, content: `错误: ${err.message}`, streaming: false,
        } : m));
        // finalize 交给外层 catch(agent.ts 的 onError 之后必然 throw,两者都会触发;
        // 幂等 guard 兜底,不会重复 append)
        setIsRunning(false);
      },
    };

    try {
      await sessionRef.current.continueAfterExecution(call, resultText, callbacks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err) ? String((err as any).message) : String(err);
      updateMessages(messagesRef.current.map(m => m.id === resultMsgId ? {
        ...m, content: `错误: ${msg}`, streaming: false,
      } : m));
      finalizeMessage(resultMsgId);
      setIsRunning(false);
    }
  };

  /** 工具分发:只读工具自动执行,写工具生成 proposal */
  const dispatchToolCalls = async (turn: AgentTurn, agentMsgId: string) => {
    if (turn.toolCalls.length === 0) {
      // 本轮没有工具调用:onDone 已写入最终文本,这里补上持久化(此前会丢失该消息)
      finalizeMessage(agentMsgId);
      setIsRunning(false);
      return;
    }

    const call = turn.toolCalls[0];
    const isReadOnly = READ_ONLY_TOOLS.has(call.name);
    const forceApproval = call.arguments.safe_to_run === false;

    if (isReadOnly && !forceApproval) {
      // 只读工具:自动执行 → 结果回传 Agent 续轮(用户看到"正在执行只读查询"的提示)
      updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
        ...m,
        content: (turn.text || '') + `\n\n⏳ 自动执行只读工具 \`${call.name}\`…`,
      } : m));

      try {
        const resultText = await executeReadOnlyTool(call);
        // 先把工具结果展示给用户(附在当前消息后)
        const preview = resultText.length > 500 ? resultText.slice(0, 500) + '\n…(截断)' : resultText;
        updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
          ...m,
          content: (turn.text || '') + `\n\n✅ \`${call.name}\` 结果:\n\`\`\`\n${preview}\n\`\`\``,
        } : m));
        // ✅ 结果已写入消息:此时持久化,保证最终内容落盘(此前成功路径从未持久化)
        finalizeMessage(agentMsgId);
        // 续轮:让 Agent 分析结果
        await continueWithResult(call, resultText);
      } catch (err) {
        const msg = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err) ? String((err as any).message) : String(err);
        updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
          ...m,
          content: (turn.text || '') + `\n\n⚠ 只读工具 \`${call.name}\` 执行失败: ${msg}`,
          streaming: false,
        } : m));
        finalizeMessage(agentMsgId);
        setIsRunning(false);
      }
      return;
    }

    // 写工具:生成 proposal 卡片(先在后端登记提案,拿回服务端生成的 id)
    let proposal: AgentProposal | null = null;

    if (call.name === 'run_command') {
      const sid = validateServerId(call.arguments.server_id);
      const cmd = call.arguments.command;
      if (!sid) {
        updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
          ...m, content: `⚠ Agent 提议缺少有效的目标服务器,已跳过。`, streaming: false,
        } : m));
        finalizeMessage(agentMsgId); setIsRunning(false); return;
      }
      if (typeof cmd !== 'string' || !cmd.trim()) {
        updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
          ...m, content: `⚠ Agent 提议缺少命令内容,已跳过。`, streaming: false,
        } : m));
        finalizeMessage(agentMsgId); setIsRunning(false); return;
      }
      let proposalId: string;
      try {
        // 提案登记在后端(服务端审批状态机):id 由服务端生成,前端不再自造 prop_ id
        proposalId = await ipc.createAgentProposal(sessionIdRef.current, sid, 'run_command', cmd, null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : (e && typeof e === 'object' && 'message' in e) ? String((e as any).message) : String(e);
        updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
          ...m, content: `⚠ 创建执行提案失败: ${msg}`, streaming: false,
        } : m));
        finalizeMessage(agentMsgId); setIsRunning(false); return;
      }
      turnRef.current.set(proposalId, turn);
      proposal = {
        id: proposalId,
        command: cmd,
        tool_name: 'run_command',
        server_id: sid,
        safe_to_run: call.arguments.safe_to_run as boolean | undefined,
        toolCall: { id: call.id, name: call.name, arguments: call.arguments },
        droppedToolCalls: turn.toolCalls.length - 1,
        status: 'pending',
      };
    } else if (call.name === 'write_file') {
      const sid = validateServerId(call.arguments.server_id);
      const path = call.arguments.path;
      const content = call.arguments.content;
      if (!sid || typeof path !== 'string' || typeof content !== 'string') {
        updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
          ...m, content: `⚠ Agent 的 write_file 提议参数不完整,已跳过。`, streaming: false,
        } : m));
        finalizeMessage(agentMsgId); setIsRunning(false); return;
      }
      let proposalId: string;
      try {
        // 提案登记在后端(服务端审批状态机),args 存完整 {path, content} JSON
        proposalId = await ipc.createAgentProposal(
          sessionIdRef.current, sid, 'write_file', null,
          JSON.stringify({ path, content }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : (e && typeof e === 'object' && 'message' in e) ? String((e as any).message) : String(e);
        updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
          ...m, content: `⚠ 创建执行提案失败: ${msg}`, streaming: false,
        } : m));
        finalizeMessage(agentMsgId); setIsRunning(false); return;
      }
      turnRef.current.set(proposalId, turn);
      proposal = {
        id: proposalId,
        command: `写入文件 ${path}`,
        tool_name: 'write_file',
        server_id: sid,
        toolCall: { id: call.id, name: call.name, arguments: call.arguments },
        droppedToolCalls: turn.toolCalls.length - 1,
        status: 'pending',
      };
    } else {
      // 未知写工具
      updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
        ...m, content: `⚠ 不支持的工具: ${call.name},已跳过。`, streaming: false,
      } : m));
      finalizeMessage(agentMsgId); setIsRunning(false); return;
    }

    updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
      ...m,
      content: turn.text || '(Agent 提议执行以下操作,请审批)',
      streaming: false,
      proposal,
    } : m));
    finalizeMessage(agentMsgId);
    setIsRunning(false);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMsg.trim() || isRunning || !session) {
      ipc.frontendLog(`[AgentPanel] handleSend 被拦截: input=${!!inputMsg.trim()} running=${isRunning} session=${!!session}`);
      return;
    }

    // compact 模式(终端右侧面板)没有 sessionId:首次发消息时自动创建会话
    // 这样终端里的对话也会持久化,在"对话记忆"里能看到
    if (!sessionIdRef.current) {
      try {
        const id = await ipc.createAgentSession(
          `${compact ? '终端助手' : '对话'} ${new Date().toLocaleString()}`,
          activeServerId ?? undefined,
        );
        sessionIdRef.current = id;
        localStorage.setItem('agent_active_session', id);
        refreshAgentSessions();  // 通知对话记忆/Sidebar 更新列表
        ipc.frontendLog(`[AgentPanel] 创建后端会话 ${id}`);
      } catch (err) { ipc.frontendLog(`[AgentPanel] 创建会话失败: ${err}`); }
    }

    const userMsg: AgentMessage = {
      id: nextId('msg'), sender: 'user', content: inputMsg.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    appendMessage(userMsg);  // 用户消息立即持久化
    setInputMsg('');
    setIsRunning(true);

    const agentMsgId = nextId('msg_agent');
    updateMessages([...messagesRef.current, {
      id: agentMsgId, sender: 'agent', content: '', streaming: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }]);

    try {
      const turn = await session.sendMessage(userMsg.content, {
        onText: (text) => updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? { ...m, content: text } : m)),
        onProposal: () => {},
        onDone: (t) => {
          updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
            ...m, content: t.text || '', streaming: false,
          } : m));
          // 持久化交给 dispatchToolCalls(它在写入最终内容/proposal 后统一 finalize)
        },
        onError: (err) => {
          updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
            ...m, content: `错误: ${err.message}`, streaming: false,
          } : m));
          // finalize 交给外层 catch(onError 之后必然 throw;幂等 guard 兜底防重复)
          setIsRunning(false);
        },
      });
      await dispatchToolCalls(turn, agentMsgId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err) ? String((err as any).message) : String(err);
      updateMessages(messagesRef.current.map(m => m.id === agentMsgId ? {
        ...m, content: `错误: ${msg}`, streaming: false,
      } : m));
      finalizeMessage(agentMsgId);
      setIsRunning(false);
    }
  };

  // 批准执行 Proposal(按工具类型分发)
  const handleApprove = async (proposalId: string) => {
    if (!session) return;
    const msg = messages.find(m => m.proposal?.id === proposalId);
    if (!msg?.proposal) return;
    const proposal = msg.proposal;
    const toolCall = proposal.toolCall;
    if (!toolCall) return;

    setIsRunning(true);
    const resultMsgId = nextId('msg_agent');
    updateMessages([...messagesRef.current, {
      id: resultMsgId, sender: 'agent', content: '', streaming: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }]);

    try {
      let resultText: string;

      if (proposal.tool_name === 'run_command' || proposal.tool_name === 'write_file') {
        // 服务端审批状态机:先批准,再经 execute_agent_proposal 执行。
        // 后端校验提案必须处于 approved 状态才执行,审批上下文由服务端构建,
        // 前端无法伪造;write_file 的 SFTP 写入也由后端完成。
        await ipc.approveAgentProposal(proposalId);
        updateMessages(messagesRef.current.map(m => m.proposal?.id === proposalId ? {
          ...m, proposal: { ...m.proposal!, approved: true, status: 'running' }
        } : m));
        finalizeMessage(msg.id);
        const res = await ipc.executeAgentProposal(proposalId);
        const execResult: ExecuteResult = {
          audit_id: res.audit_id,
          stdout: res.result.stdout,
          stderr: res.result.stderr,
          exit_code: res.result.exit_code,
          success: res.result.exit_code === 0,
        };
        updateMessages(messagesRef.current.map(m => m.proposal?.id === proposalId ? {
          ...m, proposal: {
            ...m.proposal!,
            result: execResult,
            status: execResult.success ? 'succeeded' : 'failed',
          }
        } : m));
        finalizeMessage(msg.id); // 执行结果写回 proposal,同样需要重新落盘
        if (proposal.tool_name === 'write_file') {
          const path = toolCall.arguments.path as string;
          const content = toolCall.arguments.content as string;
          resultText = `文件写入完成: ${path}(${content.length} 字符)`;
        } else {
          resultText = `命令执行完成。\nstdout:\n${execResult.stdout}\n${execResult.stderr ? 'stderr:\n' + execResult.stderr + '\n' : ''}退出码:${execResult.exit_code}`;
        }
      } else {
        throw new Error(`不支持的审批工具: ${proposal.tool_name}`);
      }

      // 续轮:让 Agent 分析执行结果
      const callbacks = {
        onText: (text: string) => updateMessages(messagesRef.current.map(m => m.id === resultMsgId ? { ...m, content: text } : m)),
        onProposal: () => {},
        onDone: (t: AgentTurn) => {
          updateMessages(messagesRef.current.map(m => m.id === resultMsgId ? { ...m, content: t.text || '(完成)', streaming: false } : m));
          // 这里不 finalize:dispatchToolCalls 写入最终内容/proposal 后统一 finalize,避免重复 append
          dispatchToolCalls(t, resultMsgId);
        },
        onError: (err: Error) => {
          updateMessages(messagesRef.current.map(m => m.id === resultMsgId ? { ...m, content: `错误: ${err.message}`, streaming: false } : m));
          // finalize 交给外层 catch(onError 之后必然 throw;幂等 guard 兜底防重复)
          setIsRunning(false);
        },
      };

      const turn = turnRef.current.get(proposalId);
      if (turn) {
        await session.continueAfterExecution(toolCall, resultText, callbacks);
      } else {
        await session.sendMessage(resultText, callbacks);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err) ? String((err as any).message) : String(err);
      updateMessages(messagesRef.current.map(m => {
        if (m.id === resultMsgId) return { ...m, content: `错误: ${errorMessage}`, streaming: false };
        if (m.proposal?.id === proposalId && m.proposal.approved) {
          return { ...m, proposal: { ...m.proposal, status: 'unknown' as const } };
        }
        return m;
      }));
      finalizeMessage(msg.id);
      finalizeMessage(resultMsgId);
      setIsRunning(false);
    }
  };

  const handleReject = async (proposalId: string) => {
    // 以后端状态为准：拒绝失败时不能把本地 UI 伪装成已拒绝。
    try {
      await ipc.rejectAgentProposal(proposalId);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      ipc.frontendLog(`[Agent] 拒绝提案失败: ${error.message}`);
      return;
    }
    let msgId = '';
    // 不在 setState updater 里捕获 msgId(updater 必须纯净,StrictMode 会双调);
    // 直接基于 messagesRef 计算新列表
    const next = messagesRef.current.map(m => {
      if (m.proposal?.id === proposalId) {
        msgId = m.id;
        return { ...m, proposal: { ...m.proposal!, approved: false, status: 'rejected' as const } };
      }
      return m;
    });
    updateMessages(next);
    // 内容已变(approved:false):幂等 guard 检测到变化会放行再次落盘,
    // 后端按 id 去重取最后一条 → 拒绝状态得以持久化
    if (msgId) setTimeout(() => finalizeMessage(msgId), 0);
  };

  /** 将当前对话存为复盘文档 */
  const handleSaveAsDoc = async (title: string) => {
    const currentSessionId = sessionIdRef.current;
    const auditEvidence = currentSessionId
      ? await ipc.getSessionAuditLogs(currentSessionId)
      : [];
    const transcript = messages
      .filter(m => m.sender !== 'system')
      .map(m => {
        const time = m.timestamp;
        if (m.sender === 'user') return `## [${time}] 用户\n${m.content}`;
        const prop = m.proposal
          ? `\n\n> 操作提案: ${m.proposal.tool_name}${m.proposal.result ? `（审计 #${m.proposal.result.audit_id}，退出码 ${m.proposal.result.exit_code}）` : `（${m.proposal.status ?? 'pending'}）`}`
          : '';
        return `## [${time}] Agent\n${m.content}${prop}`;
      })
      .join('\n\n---\n\n');

    const evidenceRows = auditEvidence.length > 0
      ? auditEvidence.map(log => `| #${log.id} | ${new Date(log.timestamp).toLocaleString()} | ${log.tool_name} | ${log.outcome} | ${log.exit_code ?? '-'} |`).join('\n')
      : '| - | - | 无关联审计 | unknown | - |';
    const content = `# 运维复盘: ${title}\n\n> 由 Witchcat Agent 会话生成的草稿。当前结论状态：待人工验证和审核。\n\n## 结果判定\n\n- 业务目标是否达成：待验证\n- 是否发生回退：待确认\n- 复盘状态：draft\n\n## 审计证据\n\n| 审计 ID | 时间 | 工具 | 结果 | 退出码 |\n| --- | --- | --- | --- | --- |\n${evidenceRows}\n\n## 对话记录\n\n${transcript}`;
    await upsertDoc({
      id: `doc_${Date.now()}`,
      type: 'postmortem',
      title,
      content,
      session_id: currentSessionId,
      server_id: activeServerId,
      generated_by: 'agent',
      tags: JSON.stringify(['agent-session']),
      status: 'draft',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setShowSaveDoc(false);
  };

  const currentServer = servers.find(s => s.id === activeServerId);
  const enabledSkills = skills.filter(s => s.enabled);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 节点信息条 */}
      <div style={{
        background: 'var(--chip-bg)', border: '1px solid var(--chip-border)',
        padding: compact ? '6px 10px' : '8px 12px', borderRadius: 8, fontSize: compact ? 11 : 12,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: compact ? 8 : 12, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Sparkles size={compact ? 12 : 14} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            节点: <strong>{currentServer?.name || '未选择'}</strong>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {messages.length > 0 && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: compact ? 10 : 11, padding: '2px 8px' }}
              onClick={() => setShowSaveDoc(true)}
              title="将当前对话存为复盘文档"
            >
              <FileText size={12} /> {!compact && '存为文档'}
            </button>
          )}
          {/* 历史对话切换按钮 */}
          {agentSessions.length > 0 && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: compact ? 10 : 11, padding: '2px 8px' }}
              onClick={() => setShowHistory(!showHistory)}
              title="切换历史对话"
            >
              <History size={12} /> {!compact && '历史'}
            </button>
          )}
          <span style={{ color: 'var(--accent-emerald)', fontSize: compact ? 10 : 11 }}>
            {enabledSkills.length} 项技能
          </span>
        </div>
      </div>

      {/* 历史对话折叠列表(compact 模式也可用) */}
      {showHistory && (
        <div style={{
          background: 'var(--panel-inset-bg)', border: '1px solid var(--border-color)',
          borderRadius: 6, padding: 6, marginBottom: 8, maxHeight: 200, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0,
        }}>
          {agentSessions.map(s => (
            <div
              key={s.id}
              onClick={() => switchSession(s.id)}
              style={{
                padding: '5px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                background: sessionIdRef.current === s.id ? 'var(--chip-bg)' : 'transparent',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {s.title || '(未命名)'} <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{new Date(s.updated_at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* 消息列表 */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: compact ? 10 : 14, paddingRight: 4, minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: compact ? '24px 8px' : 40 }}>
            <Bot size={compact ? 30 : 40} style={{ marginBottom: 8, opacity: 0.3 }} />
            <div style={{ fontSize: compact ? 12 : 13 }}>向 Agent 描述你的运维需求</div>
            {!session && <div style={{ fontSize: 11, marginTop: 8, color: 'var(--accent-rose)' }}>请先在设置中配置 LLM Provider</div>}
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} style={{ alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start', maxWidth: compact ? '96%' : '85%', display: 'flex', gap: compact ? 6 : 10 }}>
            {msg.sender === 'agent' && !compact && (
              <div style={{ background: 'var(--accent-purple)', color: '#fff', width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Bot size={16} />
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{
                background: msg.sender === 'user' ? 'var(--bubble-user-bg)' : 'var(--bubble-agent-bg)',
                border: '1px solid',
                borderColor: msg.sender === 'user' ? 'var(--bubble-user-border)' : 'var(--bubble-agent-border)',
                padding: compact ? '8px 10px' : '10px 14px', borderRadius: 10,
                fontSize: compact ? 12 : 13, lineHeight: 1.6, wordBreak: 'break-word',
              }}>
                {msg.streaming && !msg.content ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)' }}>
                    <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> 思考中...
                  </span>
                ) : msg.content.startsWith('错误:') ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent-rose)' }}>
                    <AlertCircle size={14} /> {msg.content}
                  </span>
                ) : (
                  <div className="agent-message-content">
                    <MarkdownText content={msg.content} fontSize={compact ? 12 : 13} />
                  </div>
                )}

                {/* Proposal 卡片 */}
                {msg.proposal && (
                  <ProposalCard
                    proposal={msg.proposal}
                    compact={compact}
                    onApprove={handleApprove}
                    onReject={handleReject}
                  />
                )}
              </div>
              {!compact && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, textAlign: msg.sender === 'user' ? 'right' : 'left' }}>
                  {msg.timestamp}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入框 */}
      <form onSubmit={handleSend} style={{ display: 'flex', gap: 8, marginTop: compact ? 8 : 12, flexShrink: 0 }}>
        <input
          className="input-field"
          placeholder={compact ? '问 Agent…' : '输入运维需求,例如:检查 Nginx 连接数,排查磁盘占满问题...'}
          style={compact ? { fontSize: 12, height: 32 } : undefined}
          value={inputMsg}
          onChange={e => setInputMsg(e.target.value)}
          disabled={isRunning}
        />
        <button type="submit" className="btn btn-primary" style={compact ? { height: 32, padding: '0 12px' } : undefined} disabled={isRunning || !session}>
          <Send size={14} /> {!compact && '发送'}
        </button>
      </form>

      {/* 存为文档弹窗 */}
      {showSaveDoc && (
        <SaveDocDialog
          defaultTitle={`运维对话 ${new Date().toLocaleDateString()}`}
          onSave={handleSaveAsDoc}
          onCancel={() => setShowSaveDoc(false)}
        />
      )}
    </div>
  );
};

// ==================== Proposal 卡片(按工具类型渲染) ====================

const ProposalCard: React.FC<{
  proposal: AgentProposal;
  compact?: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}> = ({ proposal, compact, onApprove, onReject }) => {
  const isWriteFile = proposal.tool_name === 'write_file';
  const fileContent = isWriteFile ? String(proposal.toolCall?.arguments.content ?? '') : '';
  const filePath = isWriteFile ? String(proposal.toolCall?.arguments.path ?? '') : '';

  return (
    <div style={{ marginTop: 10, background: 'var(--code-bg)', border: '1px solid var(--accent-purple)', borderRadius: 8, padding: compact ? 8 : 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-purple)', display: 'flex', alignItems: 'center', gap: 4 }}>
          {isWriteFile ? <FileText size={12} /> : <Terminal size={12} />}
          {isWriteFile ? '提议写入文件' : '提议执行命令'}
        </span>
        <span style={{ fontSize: 10, background: 'var(--chip-bg)', padding: '2px 6px', borderRadius: 4 }}>
          {proposal.tool_name}
          {proposal.safe_to_run && ' · 安全'}
        </span>
      </div>

      {isWriteFile ? (
        <>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: compact ? 11 : 12, color: 'var(--accent-cyan)', marginBottom: 6 }}>
            📄 {filePath}
          </div>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: compact ? 11 : 12,
            background: 'var(--code-bg)', padding: 8, borderRadius: 4,
            color: 'var(--text-main)', marginBottom: 10,
            maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {fileContent.slice(0, 500)}{fileContent.length > 500 && '\n…(仅预览前500字符)'}
          </div>
        </>
      ) : (
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: compact ? 11 : 12,
          background: 'var(--code-bg)', padding: 8, borderRadius: 4,
          color: 'var(--accent-cyan)', marginBottom: 10,
          overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>
          {proposal.command}
        </div>
      )}

      {!!proposal.droppedToolCalls && (
        <div style={{ fontSize: 11, color: 'var(--accent-amber)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
          <AlertCircle size={12} />
          本轮还有 {proposal.droppedToolCalls} 个工具调用未列出
        </div>
      )}

      {proposal.approved === undefined && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => onReject(proposal.id)}>
            <X size={12} /> 拒绝
          </button>
          <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => onApprove(proposal.id)}>
            <Check size={12} /> 批准执行
          </button>
        </div>
      )}
      {proposal.approved === true && (
        <div style={{ color: proposal.status === 'failed' || proposal.status === 'unknown' ? 'var(--accent-rose)' : 'var(--accent-emerald)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          {proposal.status === 'running' && <><Loader2 size={14} className="spin" /> 执行中</>}
          {proposal.status === 'failed' && <><X size={14} /> 执行失败</>}
          {proposal.status === 'unknown' && <><AlertCircle size={14} /> 结果未知，请人工核对后再操作</>}
          {proposal.status === 'succeeded' && <><Check size={14} /> 执行成功</>}
          {!proposal.status && <><Check size={14} /> 已批准并执行</>}
        </div>
      )}
      {proposal.approved === false && (
        <div style={{ color: 'var(--accent-rose)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <X size={14} /> 已拒绝执行
        </div>
      )}
      {proposal.result && (
        <div style={{ marginTop: 8, fontSize: 11, background: 'var(--code-bg)', padding: 8, borderRadius: 4, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', maxHeight: 100, overflowY: 'auto' }}>
          {proposal.result.stdout}
        </div>
      )}
    </div>
  );
};

// ==================== 存为文档弹窗 ====================

const SaveDocDialog: React.FC<{
  defaultTitle: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}> = ({ defaultTitle, onSave, onCancel }) => {
  const [title, setTitle] = useState(defaultTitle);
  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: 420 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>将对话存为复盘文档</h3>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>文档标题</label>
          <input
            className="input-field"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 16 }}>
          对话内容将保存为复盘文档(草稿状态),可在文档中心查看并转为 SOP 技能。
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-secondary" onClick={onCancel}><X size={14} /> 取消</button>
          <button className="btn btn-primary" onClick={() => onSave(title)} disabled={!title.trim()}>
            <Check size={14} /> 保存
          </button>
        </div>
      </div>
    </div>
  );
};
