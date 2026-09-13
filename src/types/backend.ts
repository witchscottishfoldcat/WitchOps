// Witchcat Ops IPC 契约类型定义 (匹配 docs/BACKEND_API.md)

export type ErrorCode = 
  | 'database' 
  | 'ssh' 
  | 'not_connected' 
  | 'not_found' 
  | 'vault' 
  | 'crypto' 
  | 'keychain' 
  | 'invalid_input' 
  | 'cancelled' 
  | 'internal';

export interface Server {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'private_key';
  credential_enc: string | null;
  proxy: string | null;
  host_key_fingerprint: string | null;
  tags: string | null; // JSON Array string e.g. '["web","prod"]'
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  auth_method?: 'password' | 'private_key';
  credential?: string;
  tags?: string[];
  note?: string;
}

export interface ExecuteResult {
  audit_id: number;
  stdout: string;
  stderr: string;
  exit_code: number;
  success: boolean;
}

/** Agent 提案执行结果(execute_agent_proposal 返回,审批上下文由服务端构建) */
export interface AgentExecutionResult {
  proposal_id: string;
  result: {
    stdout: string;
    stderr: string;
    exit_code: number;
  };
  audit_id: number;
}

export interface AuditFilter {
  server_id?: number;
  session_id?: string;
  source?: string;
  success?: boolean;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLog {
  id: number;
  timestamp: string;
  session_id: string | null;
  server_id: number | null;
  server_host: string | null;
  source: string;
  tool_name: string;
  command: string | null;
  args: string | null;
  exit_code: number | null;
  output: string | null;
  success: boolean;
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown';
  approved_by: string | null;
  proposal_id: string | null;
  duration_ms: number | null;
}

export interface Skill {
  id: string;
  title: string;
  content: string;
  triggers: string | null; // JSON array
  tags: string | null;     // JSON array
  applies_to: string | null; // JSON array
  risk_level: 'low' | 'medium' | 'high';
  enabled: boolean;
  source: 'manual' | 'from_doc';
  source_doc_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface QuickActionStep {
  type: 'command';
  value: string;
  capture?: string;
  guard?: string;
  confirm?: boolean;
}

export interface QuickAction {
  id: string;
  name: string;
  icon: string | null;
  target: string | null; // JSON e.g. { type: 'server', id: 1 }
  steps: string; // JSON array of QuickActionStep
  approval: 'always_ask' | 'auto_review' | 'always_approve';
  audit: boolean;
  created_at: string;
  updated_at: string;
}

export interface QuickActionExecutionResult {
  action_id: string;
  success: boolean;
  stopped_at: number | null;
  steps: Array<{
    step_index: number;
    kind: 'guard' | 'command';
    command: string;
    audit_id: number;
    exit_code: number;
    success: boolean;
  }>;
}

export interface Doc {
  id: string;
  type: 'change_record' | 'postmortem' | 'sop';
  title: string;
  content: string;
  session_id: string | null;
  server_id: number | null;
  generated_by: 'agent' | 'user' | null;
  tags: string | null;
  status: 'draft' | 'reviewed' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface ProviderInput {
  name: string;
  base_url: string;
  api_key: string; // 更新时留空 = 保持现有 key(后端 COALESCE)
  default_model?: string;
  models?: string[];
}

/** Provider 摘要(后端返回;API key 永不出后端,api_key_enc 恒为掩码) */
export interface ProviderSummary {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string; // 恒为 "***"
  has_key: boolean;    // 是否已配置 API key
  default_model: string | null;
  models: string | null; // JSON array
  created_at: string;
  updated_at: string;
}

// ============ Agent LLM 调用代理(后端流式事件) ============

export interface ChatRequest {
  request_id: string; // 前端生成的唯一 id,用于取消
  provider_id: string;
  model: string;
  messages: unknown[]; // 前端构建好的完整消息数组(含 system prompt)
  temperature?: number;
  tools: unknown; // TOOLS 数组
}

export interface ToolCallPayload {
  id: string; // 格式 call_<unix_ms>_<i>
  name: string;
  arguments: Record<string, unknown>; // 解析失败时 {}
}

export interface AgentTurnPayload {
  text: string | null;
  reasoning: string | null;
  tool_calls: ToolCallPayload[];
}

export type ChatEvent =
  | { type: 'text'; text: string }          // 累计正文
  | { type: 'reasoning'; text: string }     // 累计 reasoning
  | { type: 'done'; turn: AgentTurnPayload } // 流结束,完整 turn
  | { type: 'error'; message: string };

export interface DirEntry {
  name: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: string | null;
  permissions: number | null;
}

export interface DiskInfo {
  filesystem: string;
  mount: string;
  total: number; // KB
  used: number;  // KB
  avail: number; // KB
  usage_percent: number;
}

export interface ServerMetrics {
  cpu_usage: number;
  mem_total: number;
  mem_used: number;
  mem_available: number;
  swap_total: number;
  swap_used: number;
  load_1: number;
  load_5: number;
  load_15: number;
  uptime_seconds: number;
  disks: DiskInfo[];
}

export interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string; // running / exited
  runtime: string;
}

export interface ContainerAction {
  container_id: string;
  action: 'start' | 'stop' | 'restart' | 'remove';
  session_id?: string;
}

export interface Service {
  name: string;
  load_state: string;
  active_state: string; // active / inactive / failed
  sub_state: string; // running / dead / ...
  description: string;
}

export interface UpdateCheckResult {
  current_version: string;
  latest_tag: string;
  latest_version: string;
  release_url: string;
  published_at: string | null;
  update_available: boolean;
}
