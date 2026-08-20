# OpenCodeProxyHub

OpenCodeProxyHub 是一个独立的 AI API 网关，把 OpenCode 免费模型通过 **OpenAI 兼容** 与 **Anthropic 兼容** 的接口暴露出来，让任意支持这两种协议的客户端（opencode、各类 OpenAI/Claude SDK、第三方工具）都能直接接入。

后端为 TypeScript + Fastify，前端为 React + Vite 控制台。除了协议转换，网关还内置了 API Key 管理、出口代理池、限流、可观测性与 Docker 部署，目标是一个“可长期运行、可视化运维”的网关，而不只是一个轻量转发脚本。

OpenCodeProxyHub 基于 MIT 许可证开源，派生并大量借鉴自 [`opencode-free-proxy`](https://github.com/bigdata2211it-web/opencode-free-proxy)（同为 MIT）。本项目独立维护，与 OpenCode、`opencode-free-proxy` 及任何上游服务方均无隶属关系。

## ⚠️ 免责声明 / Disclaimer

**中文**

- 本项目仅供个人学习与技术研究使用，用于理解 OpenAI / Anthropic 兼容协议、API 网关与流式转换等实现细节。
- 使用本项目对接任何第三方服务时，使用者须自行阅读并遵守该服务的服务条款、使用政策以及所在地区的相关法律法规。
- 因使用、修改或分发本项目而产生的任何后果与责任，均由使用者自行承担，本项目作者及贡献者不承担任何责任。
- 本项目与 OpenCode、`opencode-free-proxy` 及任何第三方服务提供方均无任何隶属、授权或合作关系。
- 如本项目的任何内容被认为不适当，请提交 issue，我们会尽快处理。

**English**

- This project is provided for personal study and technical research only — to understand OpenAI/Anthropic-compatible protocols, API gateways, and streaming-conversion details.
- When using this project with any third-party service, you are solely responsible for reading and complying with that service's terms of use and the laws and regulations applicable to you.
- Any consequences and liabilities arising from use, modification, or distribution of this project are borne solely by the user. The authors and contributors accept no liability.
- This project has no affiliation, authorization, or partnership with OpenCode, `opencode-free-proxy`, or any third-party service provider.

## 可用免费模型

OpenCodeProxyHub 默认内置以下免费模型，均可通过 OpenAI 兼容接口 `/v1/chat/completions` 与 Anthropic 兼容接口 `/v1/messages` 调用：

| 模型 ID | 说明 |
|--------|------|
| `deepseek-v4-flash-free` | DeepSeek 免费模型 |
| `big-pickle` | OpenCode 免费模型 |
| `nemotron-3-ultra-free` | Nvidia Nemotron 3 Ultra 免费模型 |
| `nemotron-3.5-lightning-free` | Nvidia Nemotron 3.5 Lightning 免费模型 |
| `mimo-v2.5-free` | Mimo v2.5 免费模型 |
| `hy3-free` | Hy3 免费模型 |
| `laguna-s-2.1-free` | Laguna S 2.1 免费模型 |

> **上下文说明**：`deepseek-v4-flash-free` 实测支持约 **1M token** 上下文（models.dev 标注的 200K 仅为推荐值，Zen 服务端未按其硬截断），适合长上下文/长文档任务。

新部署会自动生成以上默认模型；已有部署升级后，缺失的默认免费模型会自动追加到已有 `models.json`，不会覆盖用户已修改的模型配置。已下线的模型（如 `north-mini-code-free`、`ling-3.0-flash-free`、`longcat-2.0-free`）会在升级时自动禁用并标记下线原因，用户无需手动清理。重新上线的模型（如 `hy3-free`）升级后会自动重新启用；仅恢复此前被自动禁用的条目，用户手动关闭的不受影响。

## 部署方式

项目支持三种部署方式，按方便程度排序：**拉取镜像快速部署**（最省事，推荐）、**本地构建 Docker 镜像**（改了源码想用容器跑）、**本地源码运行**（开发调试）。

三种方式都会在宿主机 `./data` 持久化配置（API Key、模型、代理、设置），容器删除重建数据仍在。

### 方式一：拉取镜像快速部署（推荐）

无需 clone 源码，只要一个 `docker-compose.yml` 即可启动**应用 + Redis**：

```bash
# 1. 下载编排文件与环境模板
curl -O https://raw.githubusercontent.com/Steve3184/OpenCodeProxyHub/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/Steve3184/OpenCodeProxyHub/main/.env.docker.example

# 2. 准备环境文件，并设置一个强密码
cp .env.docker.example .env.docker
#   编辑 .env.docker，把 ADMIN_PASSWORD 改成强密码

# 3. 启动（自动从 GHCR 拉取本 fork 的镜像）
docker compose up -d
```

默认应用镜像为 `ghcr.io/steve3184/opencodeproxyhub:latest`。如果你部署的是自己的 fork，先设置对应的 GHCR 镜像地址：

```bash
export OPENCODE_PROXY_HUB_IMAGE=ghcr.io/<你的 GitHub 用户名>/<你的仓库名>:latest
docker compose up -d
```

启动后控制台在 `http://127.0.0.1:6446/app`，用 `.env.docker` 中的 `ADMIN_PASSWORD` 解锁。

升级到最新镜像：

```bash
docker compose pull
docker compose up -d
```

### 方式二：本地构建 Docker 镜像（改了源码）

clone 源码后，用开发覆盖文件从当前代码构建镜像再启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`docker-compose.dev.yml` 只覆盖镜像来源（改为本地 `build`），端口、卷、Redis、健康检查等都继承自主文件。

### 方式三：本地源码运行（开发调试）

```bash
# 1. 安装依赖（后端 + 前端）
npm install
npm --prefix web install

# 2. 构建后端与前端
npm run build:all

# 3. 启动
npm run dev          # 开发模式，热重载
# 或
npm start            # 运行已构建的 dist/main.js
```

默认监听 `http://localhost:6446`，控制台在 `http://localhost:6446/app`。本地运行时限流默认走内存（`REDIS_URL` 留空）；如需分布式限流可另行配置 Redis。

常用脚本：

```bash
npm run dev          # 后端开发模式（tsx watch）
npm run dev:web      # 前端开发服务器（Vite）
npm run build:all    # 构建后端 + 前端
npm run typecheck    # 类型检查（不产出）
npm start            # 运行已构建的 dist/main.js
```

> 首次启动会在 `api-keys.json` 自动生成 `admin` 与 `user-default` 两个 Key，明文仅在启动日志中显示一次，文件里只保存 SHA-256 哈希。控制台密码来自 `ADMIN_PASSWORD`（未配置时仅保留开发环境默认值），**对外暴露前务必设置强密码并通过 HTTPS 访问**。控制台登录后由服务端签发临时会话令牌，后续管理请求不再携带管理员密码。

更多健康检查、冒烟测试、备份、反向代理与升级说明见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。公网部署建议在前面再放一层 Nginx/Caddy 等 HTTPS 反向代理（需保留 `Authorization`/`x-api-key` 头、支持长连接 SSE、关闭对流式路径的缓冲）。

## 功能总览

- **双协议兼容**
  - OpenAI 兼容：`POST /v1/chat/completions`、`GET /v1/models`
  - Anthropic 兼容：`POST /v1/messages`
  - 同时支持流式（SSE）与非流式
- **默认免费模型**：内置 7 个可用免费模型，详见上方“可用免费模型”
- **流式归一化转换（可按模型开启）**
  - `anthropic-sse-to-openai`：把上游的 Anthropic 风格 SSE 转成 OpenAI 风格 SSE
  - `think-to-reasoning`：把内联在 `delta.content` 里的 `<think>...</think>` 推理内容抽取到 `reasoning_content` 字段，正文只保留答案（支持标签跨 chunk 的状态机处理）
  - 不在列表内的模型走纯字节透传，零行为变化
- **API Key 管理**
  - 仅持久化 SHA-256 哈希，明文只在创建时返回一次
  - 兼容旧版 `{name: key}` 文件，自动迁移为带版本号的结构
  - 可选 `STORE_PLAINTEXT_API_KEYS` 模式：额外保存可恢复明文，便于在控制台复制
  - 每个 Key 支持独立**策略**：每分钟请求数、并发请求/并发流上限、允许的模型白名单、是否允许走出口代理
  - 记录请求计数、最近使用时间、最近客户端（按 `x-client-id` / `user-agent` 聚合）
- **出口代理池**
  - 支持 HTTP / HTTPS / SOCKS5 节点
  - **优先填充**选择策略：按权重从高到低，持续使用第一个可用节点，直到其禁用 / 冷却 / 达到并发或每日上限
  - 上游 429 会先自动切换到其他可用节点重试一次；连续 5 次上游 429 自动禁用节点，后台每 10 分钟发起一次最小模型请求探测，成功后自动恢复；非 429 失败进入冷却（默认 5 分钟）
  - 每日请求上限与按日自动重置，可选“达上限自动禁用 / 次日自动恢复”
  - 节点连通性测试、成功/失败计数、总 Token 与今日 Token、最近 20 次请求结果（用于前端可视化），支持单节点清空统计
  - **代理使用模式**：可在控制台选择直连、优先代理或强制代理；优先代理模式下无可用节点会自动直连
  - **链式前置代理**：所有节点出站可先经一个本机 HTTP/HTTPS 前置代理再连上游，适合节点无法直连、需先走本机代理出网的网络；可在控制台热重载开关与地址，**无需重启**
- **限流**
  - 全局每分钟请求数 + 单 Key 每分钟请求数 + 单 Key 并发请求/并发流上限
  - 默认内存实现；配置 `REDIS_URL` 后自动切换为基于 Redis Lua 脚本的分布式限流（支持多实例）
- **可观测性**
  - HTTP / 上游请求计数、最近小时请求趋势、错误率、P50/P95/P99 延迟、按状态码与路由分布、按代理分布、最近错误
  - 可配置的文件日志：管理审计日志、AI 请求摘要日志（含出口代理字段）、错误日志，JSONL 按天切分、按保留天数自动清理
- **内置 Web 控制台**（`/app`）
  - 总览、API Keys、模型、设置、代理池、监控六大页面
  - 代理池含成功率、近 N 次请求结果色条、用量/并发/连续 429 数值与 Token 统计
- **运维友好**
  - 优雅停机：关闭前排空在途请求（可配置超时）
  - 健康检查 `GET /health`
  - Docker + Docker Compose（含 Redis）一键部署

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 20+ |
| 后端 | TypeScript 5、Fastify 5、`@fastify/cors`、`@fastify/static` |
| 代理 | `https-proxy-agent`、`socks-proxy-agent` + 自研链式前置代理 Agent |
| 限流/状态 | 内存实现，或可选 Redis（`redis`）|
| 配置 | `dotenv` + JSON 文件持久化（api-keys / models / settings / proxies）|
| 前端 | React 19、Vite 6、Tailwind CSS 3、shadcn/ui（Radix）、Motion、Recharts、lucide-react |
| 部署 | Docker、Docker Compose（`node:20-bookworm-slim`，linux/amd64 + linux/arm64）|
| 许可证 | MIT |

## 项目架构与逻辑

### 整体架构

```
客户端 (opencode / OpenAI SDK / Claude SDK / curl)
        │  OpenAI 或 Anthropic 协议
        ▼
┌──────────────────────────────────────────────┐
│ OpenCodeProxyHub (Fastify)                     │
│                                                │
│  鉴权 (API Key 哈希)  →  限流 (内存/Redis)      │
│  路由 /v1/chat/completions  /v1/messages       │
│  流式转换 (passthrough / sse 转换 / think 抽取) │
│  代理池 (优先填充 + 可选链式前置代理)            │
│  可观测性 (指标 + JSONL 日志)                   │
│  Web 控制台 /app                               │
└──────────────────────────────────────────────┘
        │  出口（可选经代理池 / 前置代理）
        ▼
   OpenCode Zen 上游 API
```

### 代码结构

```
src/
  app.ts                 # 组装所有 store、限流器、路由，构建 Fastify 实例
  main.ts                # 进程入口、优雅停机
  config/env.ts          # 环境变量 → AppConfig
  auth/                  # API Key 哈希鉴权、管理员鉴权
  rateLimit/limiter.ts   # 内存 / Redis 两种限流实现（同一接口）
  routes/                # openai / anthropic / admin / models / health / web 路由
  providers/zenClient.ts # 构造上游请求、透传上游响应
  converters/            # anthropicSseToOpenAi、openAiThinkTagToReasoning 等流式转换
  proxy/                 # 代理池（优先填充）、链式前置代理 Agent
  models/catalog.ts      # 模型开关与元数据
  settings/              # 系统设置（热更新）
  observability/         # 指标 metrics、JSONL 事件日志
  runtime/               # 在途请求追踪（优雅停机排空）
  sessions/、storage/、utils/

web/src/
  App.tsx                # 控制台外壳
  hooks/useConsoleData.ts# 统一拉取/变更后端数据
  views/                 # dashboard / keys / models / settings / proxy / monitor
  components/            # 复用组件（仪表条、结果色条、弹窗等）
```

### 请求处理流程（以 `POST /v1/chat/completions` 为例）

1. **在途登记**：`RequestTracker` 登记本次请求（用于优雅停机时排空）；若正在排水则返回 503。
2. **鉴权**：从 `Authorization: Bearer` 或 `x-api-key` 取 token，按 SHA-256 哈希比对；失败返回 401。
3. **客户端记录**：按 `x-client-id` / `user-agent` 聚合记录该 Key 的最近客户端。
4. **限流**：依次校验全局 RPM、单 Key RPM、并发请求数、并发流数（Key 策略可覆盖默认值）；超限返回 429 并带 `Retry-After`。
5. **模型校验**：模型必须存在且启用，且在该 Key 的模型白名单内（白名单为空=全部允许）；否则 400/403。
6. **会话解析**：按 (Key, 协议, 模型, 头部) 解析/复用一个上游会话 ID。
7. **构造上游请求**：`prepareZenRequest` 组装上游请求体与 `x-opencode-*` 头；按当前代理使用模式与 Key 策略决定是否从**代理池**按优先填充取一个节点（lease），并据当前设置决定是否再套一层**链式前置代理**。
8. **响应处理（按模型路由）**：
   - 命中 `openAiStreamTransformModels` → `anthropic-sse-to-openai` 转换后转发；
   - 命中 `reasoningTagModels` → `think-to-reasoning` 抽取 `<think>` 后转发；
   - 其余 → 纯字节透传。
9. **回写与计数**：流式逐块写回客户端；根据上游结果给代理节点 `markSuccess` / `markFailure`（连续 429 触发熔断、其他失败进入冷却）。
10. **释放与记账**：释放限流名额与在途登记，写入指标（HTTP/上游延迟分位、状态码、按代理分布）与请求日志（含出口代理字段）。

### 代理选择逻辑（优先填充，非轮询）

从所有“启用、未冷却、未达每日上限、未达并发上限”的节点中，**按权重从高到低排序，始终取第一个**。也就是说高权重节点会被持续打满，直到它不可用，才轮到下一个——而不是请求在节点间轮转。节点连续 5 次上游 429 自动禁用，后台每 10 分钟通过模型请求探测一次，收到 2xx 后自动重新启用；其他失败进入冷却（默认 5 分钟）。

## 调用示例

OpenAI 兼容（流式）：

```bash
curl -N http://127.0.0.1:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hy3-free",
    "stream": true,
    "messages": [{"role": "user", "content": "用一句话介绍你自己"}]
  }'
```

Anthropic 兼容：

```bash
curl http://127.0.0.1:6446/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Web 控制台

控制台在 `/app`，登录后可：

- **总览**：网关状态、Key 数量、代理节点、AI 请求数等关键指标
- **API Keys**：创建（明文显示一次并可复制）、启用/禁用、删除、备注与标签、每 Key 策略（RPM、并发、模型白名单、是否允许代理）、查看请求量与最近客户端
- **模型**：启用/禁用模型，按模型开启 `anthropic-sse-to-openai` 与 `think-to-reasoning` 两种流式转换
- **设置**：上游超时、请求体限制、默认流式、代理使用模式、链式前置代理、文件日志与审计开关、日志保留天数
- **代理池**：新增/编辑/删除/测试节点，查看优先节点、成功率、近 N 次请求结果色条、用量/并发/连续 429 数值与 Token 统计
- **监控**：HTTP/上游请求量、按小时请求趋势、错误率、延迟分位、状态码与路由分布、限流器后端、运行时长、最近错误

控制台仅在浏览器本地存储临时会话令牌，不保存控制台密码。

## 配置（环境变量）

复制 `.env.example` 为 `.env` 并按需调整：

```text
PROXY_PORT=6446                         # 监听端口
PROXY_HOST=0.0.0.0                      # 监听地址
KEYS_FILE=./api-keys.json               # API Key 持久化文件
MODELS_FILE=./models.json               # 模型配置文件
SETTINGS_FILE=./settings.json           # 系统设置文件
PROXIES_FILE=./proxies.json             # 代理池文件
LOGS_DIR=./logs                         # 日志目录
ADMIN_PASSWORD=admin                    # 管理接口/控制台密码（务必修改）
ZEN_HOST=opencode.ai                    # 上游主机
ZEN_PATH=/zen/v1/chat/completions       # 上游路径
UPSTREAM_TIMEOUT_MS=120000              # 上游超时
GLOBAL_REQUESTS_PER_MINUTE=120          # 全局每分钟请求上限
API_KEY_REQUESTS_PER_MINUTE=60          # 单 Key 每分钟请求上限
API_KEY_MAX_CONCURRENT_REQUESTS=10      # 单 Key 并发请求上限
API_KEY_MAX_CONCURRENT_STREAMS=5        # 单 Key 并发流上限
REDIS_URL=                              # 留空=内存限流；填写=Redis 分布式限流
REDIS_KEY_PREFIX=opencode-proxy-hub:limit
SHUTDOWN_DRAIN_TIMEOUT_MS=30000         # 优雅停机排空超时
STORE_PLAINTEXT_API_KEYS=false          # 是否额外保存可恢复明文
PROXY_MODE=optional                     # 代理使用模式：direct / optional / required
OUTBOUND_PRE_PROXY_ENABLED=false        # 是否启用链式前置代理
OUTBOUND_PRE_PROXY_URL=                 # 前置代理地址（http/https）
REQUIRE_PROXY=false                     # 兼容旧配置；未设置 PROXY_MODE 时 true 等价于 required
PROXY_HEALTH_CHECK_MODEL=deepseek-v4-flash-free # 429 自动恢复探测使用的模型
PROXY_HEALTH_CHECK_TIMEOUT_MS=10000     # 单次恢复探测超时（毫秒）
PROXY_RECOVERY_INTERVAL_MS=600000       # 429 自动恢复探测间隔（默认 10 分钟）
```

设置项中的 `upstreamTimeoutMs`、代理使用模式、前置代理开关与地址等也可在运行时通过控制台或 `PATCH /admin/settings` **热更新**，无需重启。

## 出口代理与前置代理

- 代理使用模式支持三种：`direct` 强制直连，`optional` 有可用代理则使用、否则直连，`required` 必须使用代理、无可用节点则失败。
- 代理池节点正常情况下**直连**自己配置的代理 URL。
- 选择策略为**优先填充**：按权重从高到低排序，持续使用第一个“启用、未冷却、未达每日上限、未达并发上限”的节点。
- 节点连续 5 次收到上游 429 会被自动禁用；后台每 10 分钟通过最小模型请求探测，收到 2xx 后自动重新启用。手动禁用和每日上限禁用不会被后台自动开启；其他失败会进入冷却（默认 5 分钟）。
- 若节点无法直连、需要先经本机代理出网，可启用**链式前置代理**：

```text
OUTBOUND_PRE_PROXY_ENABLED=true
OUTBOUND_PRE_PROXY_URL=http://host.docker.internal:7897
```

  前置代理为 HTTP/HTTPS，可链接到 `http`、`https`、`socks5` 三类代理池节点；开关与地址支持控制台热重载，对下一个请求即时生效。
- `PROXY_MODE=required` 时，没有可用代理节点的请求会直接失败，而不是回退到直连上游。

## 限流

- 维度：全局每分钟请求数、单 Key 每分钟请求数、单 Key 并发请求数、单 Key 并发流数；每个 Key 可用策略覆盖默认值。
- 后端：默认内存实现；配置 `REDIS_URL` 后自动切换为基于 Redis Lua 脚本的原子限流，可在多实例间共享计数。

## 管理 API

除登录接口外，所有 `/admin/*` 接口需在 `Authorization: Bearer <SESSION_TOKEN>` 下访问。控制台登录会把密码提交给一次性登录接口，服务端验证后返回内存中的临时会话令牌；生产环境请使用 HTTPS。

```text
POST   /admin/login              # Body: {"password":"..."}，返回临时 session token
GET    /admin/session            # 当前会话鉴权状态
POST   /admin/logout             # 撤销当前会话
GET    /admin/api-keys           # 列出 API Key
POST   /admin/api-keys           # 创建 API Key（明文仅返回一次）
GET    /admin/api-keys/:id/secret# 读取可恢复明文（需开启明文存储）
PATCH  /admin/api-keys/:id       # 更新名称/启停/备注/标签/策略
DELETE /admin/api-keys/:id       # 删除 API Key
GET    /admin/models             # 列出模型
PUT    /admin/models/:id         # 新增或更新模型
DELETE /admin/models/:id         # 删除模型
GET    /admin/settings           # 读取系统设置
PATCH  /admin/settings           # 更新系统设置（热生效）
GET    /admin/proxies            # 列出代理节点
POST   /admin/proxies            # 新增代理节点
PATCH  /admin/proxies/:id        # 更新代理节点
DELETE /admin/proxies/:id        # 删除代理节点
POST   /admin/proxies/:id/test   # 测试代理连通性
GET    /admin/runtime            # 运行时与限流器快照
GET    /admin/metrics            # 指标快照
```

创建 Key：

```bash
curl -X POST http://127.0.0.1:6446/admin/api-keys \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"default-user"}'
```

按模型开启 `<think>` 推理抽取：

```bash
curl -X PATCH http://127.0.0.1:6446/admin/settings \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reasoningTagModels":["deepseek-v4-flash-free"]}'
```

## 本地数据文件

以下文件在首次运行时生成，已被 `.gitignore` 忽略，**不要提交**：

```text
api-keys.json    # API Key（哈希，可选明文）
models.json      # 模型开关与元数据
settings.json    # 系统设置
proxies.json     # 代理池节点与运行计数
```

API Key 文件结构（节选）：

```json
{
  "version": 1,
  "keys": [
    {
      "id": "...",
      "name": "admin",
      "keyHash": "...",
      "keyPrefix": "oc-1234...abcd",
      "enabled": true,
      "policy": {},
      "createdAt": "...",
      "lastUsedAt": null
    }
  ]
}
```

旧版 `{ "admin": "oc-plain-text-key" }` 格式会在加载时自动迁移到上述结构。

## 安全提示

- 对外暴露前务必修改 `ADMIN_PASSWORD`。
- API Key 默认只存哈希；开启 `STORE_PLAINTEXT_API_KEYS=true` 后新建 Key 会额外保存可恢复明文，请严格保护 `api-keys.json`（此前创建的 Key 无法恢复明文）。
- 不要把 `api-keys.json`、`.env`、`.env.docker` 等敏感文件提交到仓库。

## 文档

- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — 部署、健康检查、备份、升级
- [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md) — 分阶段实现计划与开发记录

## 许可证

OpenCodeProxyHub 基于 MIT 许可证发布，见 [`LICENSE`](./LICENSE)。

归属与第三方声明维护在：

- [`NOTICE`](./NOTICE)
- [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)

MIT 许可证仅适用于本项目源代码本身，**不授予**使用任何第三方服务、API、商标、模型提供方、代理提供方或基础设施的权利——这些须遵循各自的条款。

## 致谢与归属

本项目派生并大量借鉴自 [`opencode-free-proxy`](https://github.com/bigdata2211it-web/opencode-free-proxy)（其 `package.json` 与 `README.md` 声明 MIT 许可证）。

OpenCodeProxyHub 复现并扩展了原项目的核心兼容行为（OpenAI/Anthropic 兼容接口、OpenCode Zen 上游转发、`x-opencode-*` 请求头、模型兼容与消息转换思路），并在此基础上重写与扩展为：TypeScript/Fastify 架构、React Web 控制台、API Key 管理、代理池与链式代理、限流、可观测性与 Docker 部署。

OpenCodeProxyHub 独立维护，与 OpenCode、`opencode-free-proxy` 及任何上游服务方均无隶属关系。

## 更新记录

- **v0.1.6**：同步官方 Zen 免费模型：恢复 `hy3-free`，新增 `nemotron-3.5-lightning-free`；退役 `north-mini-code-free`、`ling-3.0-flash-free`、`longcat-2.0-free`。升级后自动追加/禁用，不覆盖用户已有配置；此前被自动禁用的 `hy3-free` 升级后自动重新启用（手动关闭的不受影响）
- **v0.1.5**：新增 `longcat-2.0-free` 默认免费模型；已有部署升级后自动追加，无需改 `models.json`（已实测上游可用，端到端验证通过）
- **v0.1.4**：移除已下线的 `hy3-free`，新增 `laguna-s-2.1-free` 与 `ling-3.0-flash-free`；升级时自动禁用退役模型，新模型自动追加
- **v0.1.3**：新增 `hy3-free` 默认免费模型；已有部署升级后自动追加，无需改 `models.json`
- **v0.1.1**：新增 Nemotron 3 Ultra 默认模型、运行时代理模式
- **v0.1.0**：初始发布

完整变更记录见 Git 提交历史。
