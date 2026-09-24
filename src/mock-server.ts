#!/usr/bin/env node
/**
 * 【industry-platform Mock MCP 服务器】
 *
 * @description
 * 双面架构的 mock 服务器,让本地页面"看似正常请求,实际返回 MCP 配置的 mock 数据":
 * - 控制面(MCP stdio):AI Agent 通过工具配置 mock 规则、查看请求日志
 * - 数据面(HTTP):页面请求经 isMock + VITE_MOCK_URL 路由到本服务,按规则返回 BaseRes 数据
 *   - 普通 HTTP 请求 → BaseRes / PageRes 响应
 *   - SSE (Accept: text/event-stream) → 按间隔推送事件流
 *   - WebSocket (ws:// upgrade) → 按规则响应消息(纯 Node.js 实现,无外部依赖)
 *
 * 启动方式(由 MCP 客户端拉起):
 * npx mock-mcp-server
 *
 * 暴露工具:
 * - get_status        查看 HTTP 服务状态与规则数量
 * - start_mock_server 启动/切换 HTTP 端口(默认 9798,进程启动时自动尝试)
 * - set_mock_data     为接口配置固定返回数据(model)
 * - set_mock_list     为分页接口配置条目模板 + 总条数,按请求 pageNum/pageSize 自动生成对应页
 * - set_mock_sse      为 SSE 接口配置事件流 mock
 * - set_mock_ws       为 WebSocket 接口配置消息响应 mock
 * - remove_mock_rule  删除单条规则
 * - clear_mock_rules  清空全部规则
 * - list_mock_rules   查看全部规则
 * - get_requests      查看页面最近的请求日志(用于发现未配置 mock 的接口)
 *
 * 数据规则:
 * - 响应统一包裹为 BaseRes:{ succeed: true, code: '0', message: '成功', model, total }
 * - 分页接口的 model 为 PageRes:{ pageNum, pageSize, size, total, pages, startRow, endRow, list }
 * - 条目模板支持:数组值按行号轮换、字符串内 {{index}} 替换为全局行号(1 开始)
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'

// ——————————————————————————————————————————————————————————————
// 常量与类型
// ——————————————————————————————————————————————————————————————

/** mock HTTP 服务默认端口 */
const DEFAULT_HTTP_PORT = 9798
/** 与后端 ResultEnum.SUCCESS 对齐的成功码(BaseRes.code 为 string) */
const SUCCESS_CODE = '0'
/** 请求日志上限 */
const MAX_LOG_SIZE = 100
/** WebSocket GUID(RFC 6455) */
const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB9DC11B65B'

/** mock 规则 */
interface MockRule {
  /** 接口路径(完整或后缀,不含 query) */
  url: string
  /** HTTP 方法(大写),缺省匹配任意方法 */
  method?: string
  /** data = 固定数据;list = 分页列表模板;sse = 事件流;ws = WebSocket */
  mode: 'data' | 'list' | 'sse' | 'ws'
  /** data 模式:作为 BaseRes.model 返回 */
  model?: unknown
  /** data 模式:直接作为整个响应体返回(不包裹 BaseRes) */
  raw?: unknown
  /** list 模式:条目模板 */
  item?: unknown
  /** list 模式:总条数,默认 50 */
  total?: number
  /** list 模式:额外字段(业务自定义,会合并到分页 model 中) */
  extra?: Record<string, unknown>
  /** 延迟响应毫秒数(模拟 loading) */
  delayMs?: number
  /** sse 模式:要推送的事件数据列表 */
  events?: unknown[]
  /** sse 模式:事件间隔毫秒,默认 1000 */
  intervalMs?: number
  /** sse 模式:发送多少个事件后关闭,缺省持续发送 */
  closeAfterEvents?: number
  /** ws 模式:连接建立后发送的初始消息 */
  initialMessage?: unknown
  /** ws 模式:收到消息后的响应列表(按序循环) */
  responses?: unknown[]
  createdAt: number
  hitCount: number
}

/** 请求日志条目 */
interface RequestLogEntry {
  time: string
  method: string
  path: string
  /** 命中的规则,null 表示未配置 mock */
  matched: string | null
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

/** 设置 mock 规则的入参(两个 set 工具共用) */
interface MockRuleInput {
  url: string
  method?: string
  model?: unknown
  raw?: unknown
  item?: unknown
  total?: number
  /** 额外字段(业务自定义,会合并到分页 model 中) */
  extra?: Record<string, unknown>
  delayMs?: number
  /** sse 模式:要推送的事件数据列表 */
  events?: unknown[]
  /** sse 模式:事件间隔毫秒,默认 1000 */
  intervalMs?: number
  /** sse 模式:发送多少个事件后关闭 */
  closeAfterEvents?: number
  /** ws 模式:连接建立后发送的初始消息 */
  initialMessage?: unknown
  /** ws 模式:收到消息后的响应列表(按序循环) */
  responses?: unknown[]
}

// ——————————————————————————————————————————————————————————————
// 规则存储与操作(供 MCP 工具与本地测试共用)
// ——————————————————————————————————————————————————————————————

const mockRules = new Map<string, MockRule>()
const requestLog: RequestLogEntry[] = []
let httpServer: Server | null = null
let httpPort: number | null = null
/** 活跃 WebSocket 连接数 */
let wsConnectionCount = 0

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ruleKey(url: string, method?: string): string {
  return `${method ?? '*'} ${url}`
}

/** 配置固定数据规则:model 作为 BaseRes.model 返回 */
export function setMockData(input: MockRuleInput): MockRule {
  const rule: MockRule = {
    url: input.url,
    method: input.method?.toUpperCase(),
    mode: 'data',
    model: input.model ?? null,
    raw: input.raw,
    delayMs: input.delayMs,
    createdAt: Date.now(),
    hitCount: 0,
  }
  mockRules.set(ruleKey(rule.url, rule.method), rule)
  return rule
}

/** 配置分页列表规则:item 为条目模板,total 为总条数 */
export function setMockList(input: MockRuleInput): MockRule {
  const rule: MockRule = {
    url: input.url,
    method: input.method?.toUpperCase(),
    mode: 'list',
    item: input.item ?? {},
    total: typeof input.total === 'number' ? input.total : 50,
    extra: input.extra,
    delayMs: input.delayMs,
    createdAt: Date.now(),
    hitCount: 0,
  }
  mockRules.set(ruleKey(rule.url, rule.method), rule)
  return rule
}

/** 配置 SSE 事件流规则:events 为要推送的事件数据列表 */
export function setMockSse(input: MockRuleInput): MockRule {
  const rule: MockRule = {
    url: input.url,
    method: input.method?.toUpperCase(),
    mode: 'sse',
    events: Array.isArray(input.events) ? input.events : [],
    intervalMs: typeof input.intervalMs === 'number' ? input.intervalMs : 1000,
    closeAfterEvents: typeof input.closeAfterEvents === 'number' ? input.closeAfterEvents : undefined,
    delayMs: input.delayMs,
    createdAt: Date.now(),
    hitCount: 0,
  }
  mockRules.set(ruleKey(rule.url, rule.method), rule)
  return rule
}

/** 配置 WebSocket mock 规则:initialMessage 为连接后首条消息,responses 为收到消息后的响应列表(循环) */
export function setMockWs(input: MockRuleInput): MockRule {
  const rule: MockRule = {
    url: input.url,
    mode: 'ws',
    initialMessage: input.initialMessage,
    responses: Array.isArray(input.responses) ? input.responses : undefined,
    createdAt: Date.now(),
    hitCount: 0,
  }
  mockRules.set(ruleKey(rule.url, rule.method), rule)
  return rule
}

/** 删除规则;method 缺省时按任意方法匹配 */
export function removeMockRule(url: string, method?: string): boolean {
  if (method) return mockRules.delete(ruleKey(url, method.toUpperCase()))
  const keys = [...mockRules.keys()].filter(key => key.endsWith(` ${url}`))
  keys.forEach(key => mockRules.delete(key))
  return keys.length > 0
}

/** 清空全部规则,返回删除数量 */
export function clearMockRules(): number {
  const count = mockRules.size
  mockRules.clear()
  return count
}

export function listMockRules(): Array<Record<string, unknown>> {
  return [...mockRules.values()].map(rule => ({
    key: ruleKey(rule.url, rule.method),
    mode: rule.mode,
    total: rule.total,
    delayMs: rule.delayMs,
    hitCount: rule.hitCount,
  }))
}

export function getRequestLog(limit = 20): RequestLogEntry[] {
  return requestLog.slice(-Math.max(1, limit))
}

/** 最长路径优先匹配;规则省略 method 时匹配任意方法 */
function matchRule(method: string, path: string): MockRule | null {
  let matched: MockRule | null = null
  for (const rule of mockRules.values()) {
    if (rule.method && rule.method !== method) continue
    if (path !== rule.url && !path.endsWith(rule.url)) continue
    if (!matched || rule.url.length > matched.url.length) matched = rule
  }
  return matched
}

// ——————————————————————————————————————————————————————————————
// SSE 数据面
// ——————————————————————————————————————————————————————————————

/** 处理 SSE mock 请求:按 intervalMs 间隔逐条推送 events 中的事件 */
async function handleSseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rule: MockRule,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
  res.flushHeaders?.()

  const events = rule.events ?? []
  const interval = rule.intervalMs ?? 1000
  const closeAfter = rule.closeAfterEvents

  let idx = 0
  const sendNext = () => {
    if (events.length === 0) {
      res.write(`data: ${JSON.stringify({ message: 'mock sse connected' })}\n\n`)
      idx++
    } else {
      const event = expandTemplate(events[idx % events.length], idx)
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      idx++
    }
    if (closeAfter && idx >= closeAfter) {
      res.end()
      return
    }
    setTimeout(sendNext, interval)
  }

  req.on('close', () => { /* client disconnected */ })
  sendNext()
}

// ——————————————————————————————————————————————————————————————
// WebSocket 数据面(纯 Node.js 实现,无外部依赖)
// ——————————————————————————————————————————————————————————————

/** 计算 WebSocket Accept Key(RFC 6455) */
function computeWsAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** 解析 WebSocket 帧(客户端→服务端,仅处理 text/close/ping) */
function parseWsFrame(buf: Buffer): { opcode: number; payload: string } | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let payloadLen = buf[1] & 0x7f
  let offset = 2
  if (payloadLen === 126) {
    if (buf.length < 4) return null
    payloadLen = buf.readUInt16BE(2)
    offset = 4
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null
    payloadLen = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null
    const maskKey = buf.subarray(offset, offset + 4)
    const payload = buf.subarray(offset + 4, offset + 4 + payloadLen)
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]!
    return { opcode, payload: payload.toString('utf8') }
  }
  if (buf.length < offset + payloadLen) return null
  return { opcode, payload: buf.subarray(offset, offset + payloadLen).toString('utf8') }
}

/** 构造 WebSocket 帧(服务端→客户端,无需 mask) */
function buildWsFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8')
  const len = payload.length
  let headerLen: number
  if (len < 126) {
    headerLen = 2
  } else if (len < 65536) {
    headerLen = 4
  } else {
    headerLen = 10
  }
  const frame = Buffer.allocUnsafe(headerLen + len)
  frame[0] = 0x81 // FIN + text opcode
  if (len < 126) {
    frame[1] = len
  } else if (len < 65536) {
    frame[1] = 126
    frame.writeUInt16BE(len, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(len), 2)
  }
  payload.copy(frame, headerLen)
  return frame
}

/** 处理 WebSocket 连接:握手 + 按 mock 规则响应消息 */
function handleWsConnection(socket: Socket, req: IncomingMessage): void {
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }

  const acceptKey = computeWsAcceptKey(key)
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey}\r\n`
    + '\r\n',
  )
  wsConnectionCount++

  const wsPath = (req.url ?? '/').replace(/\/+$/, '') || '/'
  let buffer = Buffer.alloc(0)

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    const frame = parseWsFrame(buffer)
    if (!frame) return
    buffer = Buffer.alloc(0)

    // ping → pong
    if (frame.opcode === 0x09) {
      socket.write(Buffer.from([0x8a, 0x00]))
      return
    }
    // text frame
    if (frame.opcode === 0x01) {
      const msg = frame.payload
      requestLog.push({
        time: new Date().toISOString(),
        method: 'WS',
        path: wsPath,
        matched: null,
      })
      if (requestLog.length > MAX_LOG_SIZE) requestLog.shift()

      const rule = matchRule('WS', wsPath)
      if (rule) {
        if (rule.hitCount === 0 && rule.initialMessage !== undefined) {
          socket.write(buildWsFrame(JSON.stringify(rule.initialMessage)))
        }
        rule.hitCount++
        if (rule.responses && rule.responses.length > 0) {
          const respIdx = (rule.hitCount - 1) % rule.responses.length
          const resp = expandTemplate(rule.responses[respIdx], rule.hitCount - 1)
          socket.write(buildWsFrame(JSON.stringify(resp)))
        }
      } else {
        // 兜底 echo
        socket.write(buildWsFrame(JSON.stringify({ echo: msg, timestamp: Date.now() })))
      }
    }
  })

  socket.on('error', () => { /* client disconnected */ })
  socket.on('close', () => { wsConnectionCount-- })
}

// ——————————————————————————————————————————————————————————————
// 数据生成
// ——————————————————————————————————————————————————————————————

/** 展开条目模板:数组按行号轮换,字符串内 {{index}} 替换为全局行号(1 开始) */
export function expandTemplate(template: unknown, index: number): unknown {
  if (typeof template === 'string') {
    return template.includes('{{index}}')
      ? template.replaceAll('{{index}}', String(index + 1))
      : template
  }

  if (Array.isArray(template)) {
    if (template.length === 0) return template
    // 对象数组：保留数组结构，递归展开每个元素（用于嵌套数据如 sections）
    if (template.some(item => isPlainObject(item) || Array.isArray(item))) {
      return template.map(item => expandTemplate(item, index))
    }
    // 原始值数组：按索引轮换（用于 projectName、city 等字段）
    return expandTemplate(template[index % template.length], index)
  }

  if (isPlainObject(template)) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template)) {
      result[key] = expandTemplate(value, index)
    }
    return result
  }
  return template
}

/** 包裹为 BaseRes;model 内含 total(如 PageRes)或为数组时同步顶层 total */
function wrapBaseRes(model: unknown): Record<string, unknown> {
  let total: number | undefined
  if (Array.isArray(model)) {
    total = model.length
  } else if (isPlainObject(model) && typeof model.total === 'number') {
    total = model.total
  }
  const body: Record<string, unknown> = {
    succeed: true,
    code: SUCCESS_CODE,
    message: '成功',
    model,
  }
  if (total !== undefined) body.total = total
  return body
}

/** 空分页响应(PageRes 结构),用于未配置的列表接口兜底 */
function emptyPageRes(pageNum: number, pageSize: number): Record<string, unknown> {
  return {
    pageNum,
    pageSize,
    size: 0,
    total: 0,
    pages: 0,
    startRow: 0,
    endRow: 0,
    list: [],
  }
}

/** 从 query 与 JSON body 中提取分页参数(兼容 pageNum/current/currentPage 等别名) */
function extractPaging(
  query: Record<string, string>,
  body: Record<string, unknown>,
): { pageNum: number; pageSize: number } {
  const pick = (names: string[]): number | null => {
    for (const name of names) {
      const raw = query[name] ?? body[name]
      const num = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
      if (Number.isFinite(num) && num > 0) return num
    }
    return null
  }
  return {
    pageNum: pick(['pageNum', 'current', 'pageNo', 'currentPage']) ?? 1,
    pageSize: pick(['pageSize', 'size', 'pageLength', 'limit']) ?? 10,
  }
}

/** 按规则构建响应体 */
function buildResponseBody(
  rule: MockRule | null,
  path: string,
  paging: { pageNum: number; pageSize: number },
) {
  if (!rule) {
    // 兜底:列表类路径返回空分页,其余返回 model:null,保证页面不报错、可正常渲染空态
    const model = /page|list/i.test(path) ? emptyPageRes(paging.pageNum, paging.pageSize) : null
    return wrapBaseRes(model)
  }

  if (rule.mode === 'data') {
    return rule.raw !== undefined ? rule.raw : wrapBaseRes(rule.model)
  }
  const total = rule.total ?? 50
  const pageSize = paging.pageSize
  const pageNum = paging.pageNum
  const start = (pageNum - 1) * pageSize
  const count = Math.max(0, Math.min(pageSize, total - start))
  const list = Array.from({ length: count }, (_, i) => expandTemplate(rule.item, start + i))
  const model: Record<string, unknown> = {
    pageNum,
    pageSize,
    size: count,
    total,
    pages: Math.ceil(total / pageSize),
    startRow: count > 0 ? start + 1 : 0,
    endRow: start + count,
    list,
  }
  // 合并业务自定义的额外字段
  if (rule.extra) {
    Object.assign(model, rule.extra)
  }
  return wrapBaseRes(model)
}

// ——————————————————————————————————————————————————————————————
// HTTP 数据面
// ——————————————————————————————————————————————————————————————

function sleep(ms?: number): Promise<void> {
  return ms && ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= 1024 * 1024) chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        const parsed = JSON.parse(text)
        resolve(isPlainObject(parsed) ? parsed : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  const parsedUrl = new URL(req.url ?? '/', 'http://localhost')
  const path = parsedUrl.pathname.replace(/\/+$/, '') || '/'

  // CORS:允许本地开发页面跨域直连
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    String(req.headers['access-control-request-headers'] ?? '*'),
  )
  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // SSE:检测 Accept 头,路由到 SSE 处理器
  const acceptHeader = String(req.headers.accept ?? '')
  if (acceptHeader.includes('text/event-stream')) {
    const sseRule = matchRule(method, path)
    if (sseRule && sseRule.mode === 'sse') {
      requestLog.push({ time: new Date().toISOString(), method, path, matched: ruleKey(sseRule.url, sseRule.method) })
      sseRule.hitCount++
      await handleSseRequest(req, res, sseRule)
      return
    }
  }

  const queryParams = Object.fromEntries(parsedUrl.searchParams)
  const bodyParams = await readJsonBody(req)
  const paging = extractPaging(queryParams, bodyParams)

  const rule = matchRule(method, path)
  requestLog.push({
    time: new Date().toISOString(),
    method,
    path,
    matched: rule ? ruleKey(rule.url, rule.method) : null,
  })
  if (requestLog.length > MAX_LOG_SIZE) requestLog.shift()
  if (rule) rule.hitCount += 1

  try {
    await sleep(rule?.delayMs)
    const body = buildResponseBody(rule, path, paging)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ succeed: false, code: '500', message, model: null }))
  }
}

/** 启动 HTTP 数据面;已在运行时切换端口 */
export async function startMockServer(
  port = DEFAULT_HTTP_PORT,
): Promise<{ port: number; started: boolean; message: string }> {
  if (httpServer && httpPort === port) {
    return { port, started: false, message: `mock HTTP 服务已在运行,端口 ${port}` }
  }

  if (httpServer) {
    const old = httpServer
    httpServer = null
    await new Promise<void>(resolve => old.close(() => resolve()))
  }
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      handleHttpRequest(req, res).catch(error => console.error('[mock-mcp] 请求处理失败:', error))
    })
    server.once('error', error => {
      httpServer = null
      httpPort = null
      resolve({
        port,
        started: false,
        message: `端口 ${port} 启动失败:${(error as Error).message}`,
      })
    })
    server.listen(port, '127.0.0.1', () => {
      httpServer = server
      httpPort = port
      resolve({ port, started: true, message: `mock HTTP 服务已启动:http://127.0.0.1:${port}` })
    })
    // WebSocket 升级处理
    server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      handleWsConnection(socket, req)
    })
  })
}

export function getServerStatus(): Record<string, unknown> {
  return {
    httpRunning: httpServer !== null,
    port: httpPort,
    ruleCount: mockRules.size,
    requestLogSize: requestLog.length,
    wsConnections: wsConnectionCount,
  }
}

// ——————————————————————————————————————————————————————————————
// MCP 控制面(stdio JSON-RPC)
// ——————————————————————————————————————————————————————————————

const TOOLS = [
  {
    name: 'get_status',
    description: '查看 mock HTTP 服务运行状态、端口、规则数量与请求日志条数。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'start_mock_server',
    description:
      '启动 mock HTTP 服务(进程启动时默认尝试 9798,可用环境变量 MOCK_MCP_HTTP_PORT 覆盖)。页面通过 VITE_MOCK_URL 指向该端口后,请求即由本服务返回 mock 数据。',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number', description: 'HTTP 监听端口,默认 9798' } },
      required: [],
    },
  },
  {
    name: 'set_mock_data',
    description:
      '为接口配置固定 mock 数据。页面请求命中 url 时返回 { succeed, code, message, model } 包裹的 model。url 为接口路径(支持后缀匹配,如 /api/detail);model 内容需按接口响应结构构造,字段名与接口定义一致;ID 类字段用字符串。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '接口路径,如 /api/detail' },
        method: { type: 'string', description: 'HTTP 方法,缺省匹配任意方法' },
        model: {
          type: 'object',
          description: '返回的业务数据(即 BaseRes.model),按接口类型定义构造',
        },
        raw: { type: 'object', description: '可选:直接作为整个响应体返回(不包裹 BaseRes)' },
        delayMs: { type: 'number', description: '延迟毫秒数,模拟 loading' },
      },
      required: ['url'],
    },
  },
  {
    name: 'set_mock_list',
    description:
      '为分页列表接口配置 mock。total 指定总条数,页面请求的 pageNum/pageSize 决定返回哪一页;条目模板 item 的字段名需按接口列表项类型定义构造。模板支持:数组值按行号轮换(如 3 条标题循环)、字符串内 {{index}} 替换为全局行号(1 开始)。分页 model 为 PageRes 结构(list/total/pages 等)。extra 可传入业务自定义字段(如状态计数),会合并到 model 中。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '接口路径,如 /asset-review/page' },
        method: { type: 'string', description: 'HTTP 方法,缺省匹配任意方法' },
        item: { type: 'object', description: '列表条目模板,字段与接口列表项类型一致' },
        total: { type: 'number', description: '总条数,默认 50' },
        extra: {
          type: 'object',
          description: '业务自定义字段,会合并到分页 model 中(如 statusCounts、stageCounts)',
        },
        delayMs: { type: 'number', description: '延迟毫秒数,模拟 loading' },
      },
      required: ['url', 'item'],
    },
  },
  {
    name: 'set_mock_sse',
    description:
      '为 SSE(Server-Sent Events) 接口配置 mock。页面以 Accept: text/event-stream 请求 url 时,服务端按 intervalMs 间隔逐条推送 events 中的事件数据。events 为空时持续发送心跳。closeAfterEvents 指定推送多少条后关闭连接,缺省持续发送。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'SSE 接口路径,如 /api/events/stream' },
        method: { type: 'string', description: 'HTTP 方法,默认 GET' },
        events: {
          type: 'array',
          items: { type: 'object' },
          description: '要推送的事件数据列表,支持 {{index}} 模板',
        },
        intervalMs: { type: 'number', description: '事件间隔毫秒,默认 1000' },
        closeAfterEvents: { type: 'number', description: '推送多少条后关闭,缺省持续发送' },
        delayMs: { type: 'number', description: '首次推送前的延迟毫秒数' },
      },
      required: ['url'],
    },
  },
  {
    name: 'set_mock_ws',
    description:
      '为 WebSocket 接口配置 mock。页面通过 ws:// 连接 url 时,若配置了 initialMessage 则在连接建立后立即发送;收到客户端消息后按 responses 列表顺序循环响应。未配置 responses 时默认 echo 回原始消息。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'WebSocket 接口路径,如 /ws/chat' },
        initialMessage: {
          type: 'object',
          description: '连接建立后服务端主动发送的初始消息',
        },
        responses: {
          type: 'array',
          items: { type: 'object' },
          description: '收到消息后的响应列表(按序循环),支持 {{index}} 模板',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'remove_mock_rule',
    description: '删除单条 mock 规则。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: '缺省时删除该路径任意方法的规则' },
      },
      required: ['url'],
    },
  },
  {
    name: 'clear_mock_rules',
    description: '清空全部 mock 规则。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_mock_rules',
    description: '查看全部已配置的 mock 规则及命中次数。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_requests',
    description:
      '查看页面最近请求日志(最多 100 条)。matched 为 null 表示该接口未配置 mock(已按空数据兜底),可据此补充规则。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数,默认 20' } },
      required: [],
    },
  },
]

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'get_status':
      return getServerStatus()
    case 'start_mock_server':
      return startMockServer(typeof args.port === 'number' ? args.port : DEFAULT_HTTP_PORT)
    case 'set_mock_data': {
      if (typeof args.url !== 'string' || !args.url) throw new Error('缺少必填参数: url')
      const rule = setMockData({
        url: args.url,
        method: typeof args.method === 'string' ? args.method : undefined,
        model: args.model,
        raw: args.raw,
        delayMs: typeof args.delayMs === 'number' ? args.delayMs : undefined,
      })
      return { ok: true, key: ruleKey(rule.url, rule.method), mode: rule.mode }
    }

    case 'set_mock_list': {
      if (typeof args.url !== 'string' || !args.url) throw new Error('缺少必填参数: url')
      if (args.item === undefined) throw new Error('缺少必填参数: item')
      const rule = setMockList({
        url: args.url,
        method: typeof args.method === 'string' ? args.method : undefined,
        item: args.item,
        total: typeof args.total === 'number' ? args.total : undefined,
        extra: isPlainObject(args.extra) ? args.extra : undefined,
        delayMs: typeof args.delayMs === 'number' ? args.delayMs : undefined,
      })
      return { ok: true, key: ruleKey(rule.url, rule.method), mode: rule.mode, total: rule.total }
    }

    case 'set_mock_sse': {
      if (typeof args.url !== 'string' || !args.url) throw new Error('缺少必填参数: url')
      const rule = setMockSse({
        url: args.url,
        method: typeof args.method === 'string' ? args.method : undefined,
        events: Array.isArray(args.events) ? args.events : undefined,
        intervalMs: typeof args.intervalMs === 'number' ? args.intervalMs : undefined,
        closeAfterEvents:
          typeof args.closeAfterEvents === 'number' ? args.closeAfterEvents : undefined,
        delayMs: typeof args.delayMs === 'number' ? args.delayMs : undefined,
      })
      return { ok: true, key: ruleKey(rule.url, rule.method), mode: rule.mode }
    }

    case 'set_mock_ws': {
      if (typeof args.url !== 'string' || !args.url) throw new Error('缺少必填参数: url')
      const rule = setMockWs({
        url: args.url,
        initialMessage: args.initialMessage,
        responses: Array.isArray(args.responses) ? args.responses : undefined,
      })
      return { ok: true, key: ruleKey(rule.url, rule.method), mode: rule.mode }
    }

    case 'remove_mock_rule': {
      if (typeof args.url !== 'string' || !args.url) throw new Error('缺少必填参数: url')
      const removed = removeMockRule(
        args.url,
        typeof args.method === 'string' ? args.method : undefined,
      )
      return { ok: removed }
    }
    case 'clear_mock_rules':
      return { ok: true, removed: clearMockRules() }
    case 'list_mock_rules':
      return { count: mockRules.size, rules: listMockRules() }
    case 'get_requests':
      return { requests: getRequestLog(typeof args.limit === 'number' ? args.limit : 20) }
    default:
      throw new Error(`未知工具: ${name},可用工具: ${TOOLS.map(tool => tool.name).join(' / ')}`)
  }
}

// ——————————————————————————————————————————————————————————————
// stdio 主循环(仅直接运行时启动,便于测试脚本复用内部函数)
// ——————————————————————————————————————————————————————————————

function sendResult(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function sendError(id: number | string, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function handleMessage(message: JsonRpcRequest): void {
  const { id, method } = message
  const params = message.params ?? {}
  if (id === undefined) return

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
      })
      return
    case 'ping':
      sendResult(id, {})
      return
    case 'tools/list':
      sendResult(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : ''
      const args = isPlainObject(params.arguments) ? params.arguments : {}
      // 同步抛错与异步 reject 统一返回 isError,避免异步工具失败时客户端挂起
      const sendToolError = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error)
        sendResult(id, { content: [{ type: 'text', text: message }], isError: true })
      }

      try {
        Promise.resolve(callTool(toolName, args))
          .then(value => {
            sendResult(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
          })
          .catch(sendToolError)
      } catch (error) {
        sendToolError(error)
      }
      return
    }
    case 'resources/list':
      sendResult(id, { resources: [] })
      return
    case 'prompts/list':
      sendResult(id, { prompts: [] })
      return
    default:
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

/** 解析 CLI 参数(--help / --version) */
function parseCliArgs(): void {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
mock-mcp-server - MCP server for mock data management

Usage:
  mock-mcp-server [options]

Options:
  -h, --help     Show this help message
  -v, --version  Show version number

Environment Variables:
  MOCK_MCP_HTTP_PORT  HTTP server port (default: 9798)
  MOCK_RULES_FILE     Path to initial rules JSON file (default: ./__mock-rules.json)
`)
    process.exit(0)
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log('1.0.0')
    process.exit(0)
  }
}

parseCliArgs()

// 自动启动 HTTP 数据面 (失败不影响 MCP 控制面，可通过工具换端口重试)
const envPort = Number.parseInt(process.env.MOCK_MCP_HTTP_PORT ?? '', 10)
startMockServer(Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_HTTP_PORT)
  .then(status => console.error(`[mock-mcp-server] ${status.message}`))
  .catch(error => console.error('[mock-mcp-server] HTTP 数据面启动异常:', error))

// 启动时加载初始规则文件（如果存在）
const rulesFile = process.env.MOCK_RULES_FILE ?? path.join(process.cwd(), '__mock-rules.json')
if (existsSync(rulesFile)) {
  try {
    const initialRules = JSON.parse(readFileSync(rulesFile, 'utf-8')) as Array<
      MockRuleInput & { mode?: string }
    >
    for (const ruleInput of initialRules) {
      if (ruleInput.mode === 'list' && ruleInput.item && ruleInput.total) {
        setMockList(ruleInput)
      } else if (ruleInput.mode === 'data' && ruleInput.model !== undefined) {
        setMockData(ruleInput)
      } else if (ruleInput.mode === 'sse') {
        setMockSse(ruleInput)
      } else if (ruleInput.mode === 'ws') {
        setMockWs(ruleInput)
      }
    }
    console.error(`[mock-mcp-server] 已加载 ${initialRules.length} 条初始规则`)
  } catch (error) {
    console.error('[mock-mcp-server] 加载初始规则失败:', error)
  }
}

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity })
readline.on('line', line => {
  const text = line.trim()
  if (!text) return
  let message: JsonRpcRequest
  try {
    message = JSON.parse(text) as JsonRpcRequest
  } catch {
    return
  }

  try {
    handleMessage(message)
  } catch (error) {
    console.error('[mock-mcp-server] 处理消息失败:', error)
  }
})
