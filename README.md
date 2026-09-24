# mock-mcp-server

一个零依赖的 Mock MCP 服务器，采用**双面架构**：

- **控制面（MCP stdio）**：AI Agent 通过 8 个工具动态配置 mock 规则、查看请求日志
- **数据面（HTTP）**：页面请求经路由匹配后，按规则返回符合 `BaseRes` / `PageRes` 结构的响应

让本地页面"看似正常请求，实际返回 MCP 配置的 mock 数据"，AI 工作流无需改代码即可造数据。

## 特性

- 🚀 零外部依赖，仅使用 Node.js 内置模块
- 🔧 8 个 MCP 工具，支持动态增删规则、热切换端口
- 📄 分页接口自动生成：按 `pageNum` / `pageSize` 切片，支持条目模板轮换与 `{{index}}` 占位
- 🎯 最长路径优先匹配，支持省略 method 匹配任意请求方法
- 📥 启动时自动加载初始规则文件，规则可跨重启保留
- 🔍 请求日志自动记录，便于发现未配置 mock 的接口
- 🛡️ 未配置接口智能兜底：列表类返回空 `PageRes`，其余返回 `model: null`

## 安装

```bash
# 直接运行（推荐，自动下载最新版）
npx -y mock-mcp-server

# 全局安装
npm install -g mock-mcp-server
mock-mcp-server
```

## 启动方式

### 1. 由 MCP 客户端拉起（标准用法）

在 MCP 客户端配置（如 Qoder 的 `mcp.json`）：

```json
{
  "mcpServers": {
    "mock-mcp-server": {
      "command": "npx",
      "args": ["-y", "mock-mcp-server@latest"]
    }
  }
}
```

启动后会自动尝试监听 `127.0.0.1:9798`，AI 通过 MCP 工具配置规则。

### 2. 直接运行（调试用）

```bash
npx mock-mcp-server
# 或
mock-mcp-server --help
```

## MCP 工具

| 工具 | 说明 |
|---|---|
| `get_status` | 查看 HTTP 服务运行状态、端口、规则数量 |
| `start_mock_server` | 启动 / 切换 HTTP 端口（默认 9798） |
| `set_mock_data` | 为接口配置固定返回数据（`model` 作为 `BaseRes.model`） |
| `set_mock_list` | 为分页接口配置条目模板 + 总条数，按请求参数自动生成对应页 |
| `remove_mock_rule` | 删除单条规则 |
| `clear_mock_rules` | 清空全部规则 |
| `list_mock_rules` | 查看全部规则及命中次数 |
| `get_requests` | 查看页面最近的请求日志（用于发现未配置 mock 的接口） |

## 数据规则

### 响应结构

所有响应统一包裹为 `BaseRes`：

```json
{
  "succeed": true,
  "code": "0",
  "message": "成功",
  "model": {},
  "total": 100
}
```

分页接口的 `model` 为 `PageRes` 结构：

```json
{
  "pageNum": 1,
  "pageSize": 10,
  "size": 10,
  "total": 100,
  "pages": 10,
  "startRow": 1,
  "endRow": 10,
  "list": []
}
```

### 条目模板语法

`set_mock_list` 的 `item` 模板支持：

- **数组值**：原始值数组按行号轮换（如 `["项目A", "项目B", "项目C"]` 循环）
- **对象数组**：保留结构，逐元素递归展开（用于嵌套数据）
- **字符串占位**：`{{index}}` 替换为全局行号（从 1 开始），常用于生成 ID
- **`extra` 字段**：业务自定义字段会合并到分页 `model` 中（如 `statusCounts`）

## 配置

### 端口配置

优先级从高到低：

1. MCP 工具 `start_mock_server` 的 `port` 参数（运行时热切换）
2. 环境变量 `MOCK_MCP_HTTP_PORT`（启动时读取）
3. 默认值 `9798`

```bash
MOCK_MCP_HTTP_PORT=8888 npx mock-mcp-server
```

### 初始规则文件

启动时自动加载规则文件，路径由环境变量 `MOCK_RULES_FILE` 指定，默认为 `./__mock-rules.json`：

```json
[
  {
    "mode": "list",
    "url": "/api/users/page",
    "item": { "id": "{{index}}", "name": "用户{{index}}" },
    "total": 50
  },
  {
    "mode": "data",
    "url": "/api/users/detail",
    "model": { "id": "1", "name": "张三" }
  }
]
```

## CLI 参数

```bash
mock-mcp-server [options]

Options:
  -h, --help     Show this help message
  -v, --version  Show version number

Environment Variables:
  MOCK_MCP_HTTP_PORT  HTTP server port (default: 9798)
  MOCK_RULES_FILE     Path to initial rules JSON file (default: ./__mock-rules.json)
```

## 典型工作流

1. **启动 MCP 服务**：由 AI 客户端自动拉起
2. **页面发起请求**：未配置的接口会返回空兜底，并被记录到请求日志
3. **AI 调用 `get_requests`**：查看页面实际请求了哪些接口
4. **AI 读取接口类型定义**：按 `BaseRes` / `PageRes` 结构构造模板
5. **AI 调用 `set_mock_list` / `set_mock_data`**：配置规则
6. **刷新页面**：立即看到 mock 数据，无需重启

## 注意事项

- 规则默认**仅保存在内存**，进程退出即丢失；如需持久化，请配置 `MOCK_RULES_FILE` 初始规则文件
- 同一时刻只能有一个进程绑定数据面端口，多 MCP 客户端并发会冲突
- 修改规则**无需重启**，工具调用后立即生效，刷新页面即可

## License

MIT
