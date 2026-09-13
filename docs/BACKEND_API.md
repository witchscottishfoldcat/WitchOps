# Witchcat Ops 后端 IPC 契约(前端对接文档)

> 本文档供前端对接 Tauri 2 + Rust 后端使用。命令按业务域通过 `invoke()` 暴露。
>
> **调用方式**:`import { invoke } from '@tauri-apps/api/core'`
> ```ts
> const servers = await invoke('list_servers')
> ```
>
> **错误处理**:后端错误形如 `{ code: ErrorCode, message: string }`。code 是枚举:
> `database | ssh | not_connected | not_found | vault | crypto | keychain | invalid_input | cancelled | internal`
>
> **命令分区**:① 凭证库 ② 服务器 ③ Provider ④ 终端流 ⑤ SFTP ⑥ 审计 ⑦ Skills/快捷指令 ⑧ 文档 ⑨ 监控 ⑩ 容器/systemd

---

## 错误码

| code | 含义 |
|---|---|
| `database` | 数据库错误 |
| `ssh` | SSH 连接/执行错误 |
| `not_connected` | 指定服务器未连接 |
| `not_found` | 资源不存在 |
| `vault` | 凭证库未解锁/主密码错 |
| `crypto` | 加密解密失败 |
| `keychain` | OS keychain 读写失败 |
| `invalid_input` | 参数校验失败 |
| `cancelled` | 操作被取消 |
| `internal` | 其他内部错误 |

---

## 一、凭证库(Vault)

凭证库用主密码解锁。所有敏感数据(SSH 密码/私钥、API key)都用 AES-GCM-256 加密存储,解锁后才能用。

### `vault_is_initialized() → boolean`
检查 Vault 是否已初始化(首次使用需先 setup)。

### `vault_setup(master_password: string) → void`
**首次初始化** Vault,设置主密码。已初始化时报 `invalid_input`。

### `vault_unlock(master_password: string) → void`
用主密码解锁。主密码错时报 `vault`。已解锁时直接成功。

### `vault_lock() → void`
锁定(清除内存中的 data key)。

### `vault_is_unlocked() → boolean`
是否已解锁。

**典型流程**:
```ts
if (!(await invoke('vault_is_initialized'))) {
  await invoke('vault_setup', { masterPassword: 'xxx' })
}
await invoke('vault_unlock', { masterPassword: 'xxx' })
```

---

## 二、服务器管理

### `list_servers() → Server[]`
```ts
interface Server {
  id: number
  name: string
  host: string
  port: number
  username: string
  auth_method: 'password' | 'private_key'
  credential_enc: string | null   // 密文,前端不直接用
  proxy: string | null
  host_key_fingerprint: string | null
  tags: string | null             // JSON 数组字符串 '["web","prod"]'
  note: string | null
  created_at: string
  updated_at: string
}
```

### `get_server(id: number) → Server`

### `create_server(input: ServerInput) → number`
返回新服务器 id。
```ts
interface ServerInput {
  name: string
  host: string
  port?: number            // 默认 22
  username: string
  auth_method?: string     // 默认 'password'
  credential?: string      // 明文密码或私钥 PEM,后端加密存储
  tags?: string[]
  note?: string
}
```
> ⚠️ 创建/更新服务器前,Vault 必须已解锁(否则无法加密 credential)。

### `update_server(id: number, input: ServerInput) → void`
`credential` 为空或 undefined 时保留原凭证。

### `delete_server(id: number) → void`

### `connect_server(id: number) → string`
用存储的加密凭证连接。**返回 host key 指纹**(`SHA256:xxx`)。
- 首次连接(`host_key_fingerprint` 为空):前端应展示指纹给用户确认,确认后调 `confirm_host_key`
- 已有指纹:后端严格校验,不匹配报 `ssh`

### `confirm_host_key(id: number, fingerprint: string) → void`
用户确认指纹后,存入数据库。

### `disconnect_server(id: number) → void`

### `server_connection_status(id: number) → boolean`
是否已连接。

命令执行不暴露接受任意 `source/approved_by` 的通用 IPC。Agent、快捷指令、
容器与服务操作分别使用专用命令，由后端构造可信审计上下文并调用内部统一执行器。

---

## 三、审计日志(需求1:记录 Agent 操作)

### `query_audit_logs(filter: AuditFilter) → AuditLog[]`
```ts
interface AuditFilter {
  server_id?: number
  session_id?: string
  source?: string
  success?: boolean
  search?: string           // 命令内容模糊搜索
  from?: string             // ISO 时间
  to?: string
  limit?: number            // 默认 100
  offset?: number           // 默认 0
}

interface AuditLog {
  id: number
  timestamp: string         // ISO8601
  session_id: string | null
  server_id: number | null
  server_host: string | null
  source: string
  tool_name: string
  command: string | null
  args: string | null       // JSON
  exit_code: number | null
  output: string | null     // 截断到 2000 字符
  success: boolean
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown'
  approved_by: string | null
  proposal_id: string | null
  duration_ms: number | null
}
```

### `get_session_audit_logs(session_id: string) → AuditLog[]`
获取某次会话的全部审计日志(按时间正序,用于复盘文档生成)。

### `audit_stats() → { total, success, failed, unknown, pending }`

---

## 四、Skills — 运维 SOP 技能包(需求2-A)

### `list_skills() → Skill[]`
### `list_enabled_skills() → Skill[]`
仅返回 enabled=true 的,用于注入 Agent 系统提示。
```ts
interface Skill {
  id: string                // slug
  title: string
  content: string           // markdown
  triggers: string | null   // JSON 数组
  tags: string | null       // JSON 数组
  applies_to: string | null // JSON 数组
  risk_level: 'low' | 'medium' | 'high'
  enabled: boolean
  source: 'manual' | 'from_doc'
  source_doc_id: string | null
  version: number
  created_at: string
  updated_at: string
}
```

### `get_skill(id: string) → Skill`
**Agent 的 `get_skill` 工具调用此命令** 按需加载完整内容。

### `upsert_skill(skill: Skill) → void`
新建或更新(冲突时 version 自增)。

### `delete_skill(id: string) → void`

### `toggle_skill(id: string, enabled: boolean) → void`

---

## 五、快捷指令(需求2-B)

### `list_quick_actions() → QuickAction[]`
```ts
interface QuickAction {
  id: string
  name: string
  icon: string | null
  target: string | null     // JSON: {type: "server"|"group", id}
  steps: string             // JSON 数组,见下
  approval: 'always_ask' | 'auto_review' | 'always_approve'
  audit: boolean
  created_at: string
  updated_at: string
}
```
**steps 结构**(JSON 字符串):
```json
[
  {"type":"command","value":"systemctl status nginx","capture":"status"},
  {"type":"command","value":"nginx -t","guard":"{{status.exit_code}} === 0"},
  {"type":"command","value":"systemctl reload nginx","confirm":true}
]
```

### `upsert_quick_action(action: QuickAction) → void`
### `delete_quick_action(id: string) → void`
### `execute_quick_action(action_id, server_id, expected_updated_at, user_confirmed) → QuickActionExecutionResult`

> 快捷指令由后端读取用户预览过的版本并串行执行。guard 或普通步骤非零退出时停止后续步骤。

---

## 六、文档沉淀(需求3)

### `list_docs() → Doc[]`
### `get_doc(id: string) → Doc`
```ts
interface Doc {
  id: string
  type: 'change_record' | 'postmortem' | 'sop'
  title: string
  content: string           // markdown
  session_id: string | null
  server_id: number | null
  generated_by: 'agent' | 'user' | null
  tags: string | null       // JSON
  status: 'draft' | 'reviewed' | 'archived'
  created_at: string
  updated_at: string
}
```

### `upsert_doc(doc: Doc) → void`
Agent 生成文档后调此存储。

### `update_doc_status(id: string, status: string) → void`
`draft → reviewed → archived`

### `delete_doc(id: string) → void`

### `doc_to_skill(doc_id: string, skill_id: string, title: string) → void`
**文档转技能**(打通经验飞轮闭环)。

---

## 前端页面建议(对应侧边栏)

| 页面 | 调用的命令 |
|---|---|
| 服务器管理 | list_servers / create_server / connect_server / disconnect_server |
| 终端 | terminal_open / terminal_input / terminal_resize / terminal_close + 事件监听 |
| Agent 聊天 | agent_chat(LLM 代理流) + create/approve/reject/execute_agent_proposal + get_skill |
| 审计日志 | query_audit_logs / get_session_audit_logs / audit_stats |
| Skills | list_skills / upsert_skill / toggle_skill |
| 快捷指令 | list_quick_actions / upsert_quick_action |
| 文档 | list_docs / get_doc / upsert_doc / doc_to_skill |
| 文件管理 | sftp_list_dir / sftp_read_file / sftp_write_file / sftp_* |
| 监控仪表盘 | get_metrics |
| 容器管理 | list_containers / control_container |
| 服务管理 | list_services / control_service |
| 设置 | vault_* + list_providers / create_provider |

---

## 数据流(经验飞轮闭环)

```
Agent 执行(create_agent_proposal → approve_agent_proposal → execute_agent_proposal)
    → 后端自动写 audit_logs(审计上下文完全由服务端构建)
会话结束
    → 前端拉 get_session_audit_logs + 对话内容
    → 调 LLM 生成复盘文档 → upsert_doc
用户审核文档
    → 点"存为技能" → doc_to_skill
下次 Agent
    → list_enabled_skills 注入系统提示 → get_skill 按需加载
    → 又走提案审批流 → 闭环
```

---

## 待实现(后续 Phase)

- MCP Client/Server(Phase 5)

---

## 七、LLM Provider 管理

### `list_providers() → ProviderSummary[]`
返回所有 provider。**API key 永不出后端**:`api_key_enc` 恒为掩码 `***`,
前端只能通过 `has_key` 知道该 provider 是否已配置 key;真正的 LLM 调用由
`agent_chat` 命令在后端解密 key 后代理发出。
```ts
interface ProviderSummary {
  id: string
  name: string
  base_url: string         // 如 https://api.deepseek.com
  api_key_enc: string      // 恒为掩码 '***'(密钥不出后端)
  has_key: boolean         // 是否已配置 API key
  default_model: string | null
  models: string | null    // JSON 数组 '["deepseek-chat",...]'
  created_at: string
  updated_at: string
}
```

### `get_provider(id: string) → ProviderSummary`
### `create_provider(input: ProviderInput) → string`
返回新 provider id。需 Vault 已解锁,**api_key 必填**。
```ts
interface ProviderInput {
  name: string
  base_url: string
  api_key: string          // 明文,后端加密存储;update 时留空 = 保持不变
  default_model?: string
  models?: string[]
}
```
### `update_provider(id: string, input: ProviderInput) → void`
### `delete_provider(id: string) → void`

### `agent_chat(request, out: Channel<ChatEvent>) → void`
LLM 流式调用代理(OpenAI 兼容 `/chat/completions`,SSE)。命令立即返回,
流事件经 `out` Channel 推送:`text`(累计正文)/ `reasoning` / `done`(完整 turn)/
`error`。配套 `agent_chat_cancel(request_id)` 取消在途请求。

### Agent 提案审批状态机
`create_agent_proposal(...) → prop_id` → `approve_agent_proposal(id)`(或 `reject_agent_proposal(id)`)
→ `execute_agent_proposal(id) → { proposal_id, result, audit_id }`。
只有服务端批准的提案才能执行；应用不暴露可由前端伪造审计来源的通用命令入口。

---

## 八、交互式终端流 ⭐

终端是运维工具灵魂。后端用 PTY + Tauri 事件实现持续双向流。

### 打开终端
```ts
const termId = await invoke('terminal_open', {
  serverId: 1, cols: 80, rows: 24  // cols/rows 可选,默认 80x24
})
// 返回 terminal_id: "term_xxx"
```

### 监听输出事件(后端 → 前端)
```ts
import { listen } from '@tauri-apps/api/event'
const unlisten = await listen<{ data: string }>(
  `terminal_output_${termId}`,  // 事件名
  (event) => {
    // event.payload.data 是 base64 编码的服务器输出
    const bytes = Uint8Array.from(atob(event.payload.data), c => c.charCodeAt(0))
    term.write(bytes)  // 写入 xterm.js
  }
)
// 终端结束时:
await listen(`terminal_exit_${termId}`, (e) => { /* e.payload.code 是退出码 */ })
```

### 发送用户输入(前端 → 后端)
```ts
// xterm.js 的 onData 回调:
term.onData((data) => {
  // data 是字符串,转 base64
  const b64 = btoa(data)
  invoke('terminal_input', { terminalId: termId, data: b64 })
})
```
> 注意:输入要 base64 编码,因为可能含二进制(如方向键转义序列)。

### Resize
```ts
term.onResize(({ cols, rows }) => {
  invoke('terminal_resize', { terminalId: termId, cols, rows })
})
```

### 关闭
```ts
await invoke('terminal_close', { terminalId: termId })
// 关闭页面时务必调用,否则终端 session 会泄漏
```

---

## 九、SFTP 文件操作

### `sftp_list_dir(server_id: number, path: string) → DirEntry[]`
```ts
interface DirEntry {
  name: string
  is_dir: boolean
  is_symlink: boolean
  size: number           // 字节
  modified: string | null  // ISO 时间
  permissions: number | null
}
```
返回结果已排序:目录在前,文件在后,各自按名字排。

### `sftp_read_file(server_id: number, path: string) → string`
读取文本文件(限 1MB),返回 UTF-8 字符串。超限或非 UTF-8 报错。

### `sftp_write_file(server_id: number, path: string, content: string) → void`
写入文本文件(覆盖)。

### `sftp_delete_file(server_id: number, path: string) → void`
### `sftp_mkdir(server_id: number, path: string) → void`
### `sftp_rmdir(server_id: number, path: string) → void`
### `sftp_rename(server_id: number, from: string, to: string) → void`
### `sftp_stat(server_id: number, path: string) → PathInfo`
```ts
interface PathInfo {
  canonical: string
  exists: boolean
  is_dir: boolean
  size: number
}
```

---

## 十、监控采集

### `get_metrics(server_id: number) → ServerMetrics`
通过 SSH 读 `/proc` 和 `free`/`df` 采集实时指标。
```ts
interface ServerMetrics {
  cpu_usage: number       // 百分比 0-100
  mem_total: number       // KB
  mem_used: number        // KB
  mem_available: number   // KB
  swap_total: number      // KB
  swap_used: number       // KB
  load_1: number
  load_5: number
  load_15: number
  uptime_seconds: number
  disks: DiskInfo[]
}
interface DiskInfo {
  filesystem: string
  mount: string
  total: number           // KB
  used: number            // KB
  avail: number           // KB
  usage_percent: number
}
```
> 前端可每 3-5 秒轮询一次做仪表盘。

---

## 十一、容器管理

### `list_containers(server_id: number, runtime?: string) → Container[]`
`runtime` 默认 `"docker"`,可传 `"podman"`。
```ts
interface Container {
  id: string
  name: string
  image: string
  status: string
  state: string           // running / exited / ...
  runtime: string
}
```

### `control_container(server_id: number, action: ContainerAction) → ExecuteResult`
```ts
interface ContainerAction {
  container_id: string
  action: 'start' | 'stop' | 'restart' | 'remove'
  session_id?: string
}
```
> 容器操作**走统一执行出口**,自动写审计日志。

---

## 十二、systemd 服务管理

### `list_services(server_id: number) → Service[]`
```ts
interface Service {
  name: string            // 如 nginx.service
  load_state: string
  active_state: string    // active / inactive / failed
  sub_state: string       // running / dead / ...
  description: string
}
```

### `control_service(server_id: number, service_name: string, action: string, session_id?: string) → ExecuteResult`
`action`: `start` / `stop` / `restart` / `enable` / `disable` / `status`。
> 服务操作也走统一执行出口,写审计日志。

---

## 十三、应用更新检查

### `check_app_update() → UpdateCheckResult`
```ts
interface UpdateCheckResult {
  current_version: string   // 编译期 CARGO_PKG_VERSION
  latest_tag: string        // 如 'v0.1.0'
  latest_version: string    // tag 去 v 前缀,如 '0.1.0'
  release_url: string       // GitHub 发布页(已校验为本仓库域)
  published_at: string | null
  update_available: boolean // 语义化版本比较(major.minor.patch)
}
```
> 后端直连 GitHub Releases(10s 超时,无需凭证);设置页手动触发,不做后台轮询。
> 版本号不规范(非 `v?X.Y.Z`)时按"无更新"处理,不误报。
