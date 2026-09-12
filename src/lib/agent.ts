// Witchcat Ops Agent 引擎(LLM 调用经后端代理)
//
// 设计(借鉴 MaidKit ssh_agent_service.dart):
// - LLM 的 HTTP 调用 + SSE 解析在后端(agent_chat 命令)完成,
//   API key 永不进入前端;前端只收类型化流事件(Channel)
// - Proposal 与 Execution 解耦:LLM 只能提案,审批后才执行
// - 工具带 safe_to_run 标记
// - 输出截断防 token 爆炸
//
// 用法:
//   const session = new AgentSession(providers, skills, servers)
//   await session.sendMessage(userText, { onText, onProposal, onDone })

import * as ipc from './ipc';

// ============ 类型 ============

export interface AgentConfig {
  providerId: string;
  model: string;
}

export interface AgentServer {
  id: number;
  name: string;
  host: string;
  tags: string[];
}

export interface AgentSkillInfo {
  id: string;
  title: string;
  triggers: string[];
  appliesTo: string[];
  riskLevel: 'low' | 'medium' | 'high';
  version: number;
}

export interface AgentToolCall {
  id: string;
  name: string;           // run_command / read_file / ... / mcp_xxx__yyy
  arguments: Record<string, unknown>;
}

export interface AgentTurn {
  text: string | null;
  reasoning: string | null;
  toolCalls: AgentToolCall[];
}

export interface AgentCallbacks {
  onText: (text: string) => void;
  onProposal: (call: AgentToolCall) => void;
  onDone: (turn: AgentTurn) => void;
  onError: (err: Error) => void;
}

// ============ 工具定义 ============

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Run one shell command on the selected server',
      parameters: {
        type: 'object',
        properties: {
          server_id: { type: 'integer', description: 'Target server ID' },
          command: { type: 'string', description: 'Shell command to run' },
          safe_to_run: { type: 'boolean', description: 'True if read-only/safe' },
        },
        required: ['server_id', 'command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the selected server',
      parameters: {
        type: 'object',
        properties: {
          server_id: { type: 'integer' },
          path: { type: 'string' },
          safe_to_run: { type: 'boolean' },
        },
        required: ['server_id', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 text file on the selected server',
      parameters: {
        type: 'object',
        properties: {
          server_id: { type: 'integer' },
          path: { type: 'string' },
          content: { type: 'string' },
          safe_to_run: { type: 'boolean' },
        },
        required: ['server_id', 'path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_metrics',
      description: 'Get CPU/memory/disk/load metrics for the server',
      parameters: {
        type: 'object',
        properties: {
          server_id: { type: 'integer' },
          safe_to_run: { type: 'boolean' },
        },
        required: ['server_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_skill',
      description: 'Read a skill/SOP document by ID (call when you need specific operational guidance)',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill ID' },
          safe_to_run: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
  },
];

// ============ Agent Session ============

export class AgentSession {
  private config: AgentConfig;
  private servers: AgentServer[];
  private skills: AgentSkillInfo[];
  private history: Array<Record<string, unknown>> = [];
  private cancelFlag = false;
  /** 当前在途请求的后端 id(用于取消) */
  private streamRequestId: string | null = null;
  /** 取消时结算当前流的回调(后端取消后不再发 Done) */
  private cancelSettle: (() => void) | null = null;

  constructor(
    config: AgentConfig,
    servers: AgentServer[],
    skills: AgentSkillInfo[],
  ) {
    this.config = config;
    this.servers = servers;
    this.skills = skills;
  }

  /** 更新会话上下文(服务器/技能列表变化时调用,保留对话历史) */
  updateContext(servers: AgentServer[], skills: AgentSkillInfo[]) {
    this.servers = servers;
    this.skills = skills;
  }

  /** 从持久化消息重建 LLM 对话上下文(history)
   *  注意:只能恢复纯文本对话脉络;tool_call/tool 结果等结构化上下文无法重建,
   *  因此续轮关联可能不完美,但基本的"之前聊过什么"能记住。 */
  restoreHistory(messages: Array<{ sender: string; content: string }>) {
    this.history = [];
    for (const msg of messages) {
      const text = msg.content?.trim();
      if (!text) continue;
      // 跳过错误消息和工具执行中间态(含 ⚠/⏳/✅ 前缀的)
      if (text.startsWith('错误:') || text.startsWith('⚠')) continue;
      if (msg.sender === 'user') {
        this.history.push({ role: 'user', content: text });
      } else if (msg.sender === 'agent') {
        // 只取 agent 消息的正文部分(去掉工具结果块)
        const cleanText = text.split('\n\n⏳')[0].split('\n\n✅')[0].trim();
        if (cleanText) this.history.push({ role: 'assistant', content: cleanText });
      }
    }
  }

  /** 构建系统提示 */
  private systemPrompt(): string {
    const serverList = this.servers.map(s =>
      `- ${s.name} (id=${s.id}, host=${s.host}, tags=${s.tags.join(',') || 'none'})`
    ).join('\n');
    const skillList = this.skills.length > 0
      ? this.skills.map(s =>
          `- ${s.id}@v${s.version}: ${s.title}; triggers=${s.triggers.join(',') || 'none'}; applies_to=${s.appliesTo.join(',') || 'all'}; risk=${s.riskLevel}`
        ).join('\n')
      : '(无)';
    return `You are Witchcat Ops, an AI assistant for server operations.

Available servers:
${serverList}

Available SOP skills:
${skillList}

Rules:
- ALWAYS propose actions via tool calls. Never directly claim to have executed something.
- Set safe_to_run=true only for read-only operations (read_file, get_metrics, get_skill, ls/cat/status).
- For destructive or risky operations, set safe_to_run=false so the user reviews them.
- Before using an SOP, check applies_to against the target server tags and call get_skill for the exact published version shown above.
- Be concise. When a command completes, summarize the result.
- If the user asks about a server not in the list, say so.`;
  }

  /** 取消当前请求(通知后端断开连接;已积累内容作为结果返回,不报错) */
  cancel() {
    if (this.cancelFlag) return;
    this.cancelFlag = true;
    if (this.streamRequestId) {
      ipc.agentChatCancel(this.streamRequestId).catch(() => {});
    }
    this.cancelSettle?.();
  }

  /** 发送用户消息,返回 Agent 的第一轮输出(含可能的 Proposal) */
  async sendMessage(userText: string, callbacks: AgentCallbacks): Promise<AgentTurn> {
    this.cancelFlag = false;
    this.history.push({ role: 'user', content: userText });
    const turn = await this.streamChat(callbacks);
    return turn;
  }

  /** 续轮:把执行结果塞回历史,继续对话 */
  async continueAfterExecution(
    call: AgentToolCall,
    result: string,
    callbacks: AgentCallbacks,
  ): Promise<AgentTurn> {
    // 塞 assistant 消息(含 tool_call)
    this.history.push({
      role: 'assistant',
      tool_calls: [{
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }],
    });
    // 塞 tool 结果
    this.history.push({
      role: 'tool',
      tool_call_id: call.id,
      content: result,
    });
    return this.streamChat(callbacks);
  }

  // ============ 内部:经后端代理流式调用 LLM ============

  private async streamChat(callbacks: AgentCallbacks): Promise<AgentTurn> {
    const messages = [
      { role: 'system', content: this.systemPrompt() },
      ...this.history,
    ];

    this.cancelFlag = false;
    const requestId = `${Date.now()}_${reqCounter++}`;
    this.streamRequestId = requestId;

    let text = '';
    let reasoning = '';
    let toolCalls: AgentToolCall[] = [];

    // 等后端事件流结束。三种终态:
    // - Done 事件 → 正常结算;
    // - Error 事件 / invoke 拒绝 → onError + reject(与旧 fetch 路径一致);
    // - cancel() → 后端停止推送(不发 Done),由 cancelSettle 主动结算部分结果。
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this.cancelSettle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      ipc.agentChat(
        {
          request_id: requestId,
          provider_id: this.config.providerId,
          model: this.config.model,
          messages,
          tools: TOOLS,
        },
        (ev) => {
          switch (ev.type) {
            case 'text':
              text = ev.text;
              callbacks.onText(text);
              break;
            case 'reasoning':
              reasoning = ev.text;
              break;
            case 'done':
              toolCalls = ev.turn.tool_calls.map(tc => ({ ...tc }));
              if (settled) return;
              settled = true;
              resolve();
              break;
            case 'error': {
              if (settled) return;
              settled = true;
              const error = new Error(ev.message);
              callbacks.onError(error);
              reject(error);
              break;
            }
          }
        },
      ).catch((err) => {
        // 命令本身失败(provider 不存在 / 解密失败等)
        if (settled) return;
        settled = true;
        const error = err instanceof Error ? err : new Error(String(err));
        callbacks.onError(error);
        reject(error);
      });
    });

    this.cancelSettle = null;
    this.streamRequestId = null;

    const turn: AgentTurn = {
      text: text || null,
      reasoning: reasoning || null,
      toolCalls,
    };

    // 保存到历史(assistant 消息)。
    // 注意:带 tool_calls 的轮次**不**入历史 —— 必须等工具执行结果,
    // 由 continueAfterExecution 以「assistant(tool_call) + tool(结果)」成对补入,
    // 否则模型上下文缺失自己提议的命令,且 API 会因 tool_call 未响应而报错。
    if (text) this.history.push({ role: 'assistant', content: text });

    callbacks.onDone(turn);
    return turn;
  }
}

/** 请求 id 自增计数器(同毫秒内区分多轮) */
let reqCounter = 0;

// ============ 辅助:从后端加载配置 ============

/** 加载当前可用的 LLM 配置(从第一个已配置 key 的 provider) */
export async function loadAgentConfig(): Promise<AgentConfig | null> {
  const providers = await ipc.listProviders();
  const p = providers.find(pr => pr.has_key);
  if (!p) return null;
  let models: string[] = [];
  if (p.models) {
    try { models = JSON.parse(p.models); } catch { models = []; }
  }
  const model = p.default_model || models[0] || 'gpt-4o';
  return { providerId: p.id, model };
}

/** 加载启用的技能(注入系统提示) */
export async function loadEnabledSkills(): Promise<AgentSkillInfo[]> {
  const skills = await ipc.listEnabledSkills();
  return skills.map(s => {
    let triggers: string[] = [];
    let appliesTo: string[] = [];
    if (s.triggers) {
      try { triggers = JSON.parse(s.triggers); } catch { triggers = []; }
    }
    if (s.applies_to) {
      try { appliesTo = JSON.parse(s.applies_to); } catch { appliesTo = []; }
    }
    return {
      id: s.id,
      title: s.title,
      triggers,
      appliesTo,
      riskLevel: s.risk_level,
      version: s.version,
    };
  });
}

/** 加载服务器列表 */
export async function loadAgentServers(): Promise<AgentServer[]> {
  const servers = await ipc.listServers();
  return servers.map(s => {
    let tags: string[] = [];
    if (s.tags) {
      try { tags = JSON.parse(s.tags); } catch { tags = []; }
    }
    return { id: s.id, name: s.name, host: s.host, tags };
  });
}

/** 执行 get_skill 工具(从后端加载技能内容) */
export async function executeGetSkill(id: string): Promise<string> {
  const skill = await ipc.getSkill(id);
  return skill.content;
}
