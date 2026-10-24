# cursor-byok — CCursor BYOK Server in Docker

把 [CCursor (Cursor++)](https://github.com/CometixSpace/CCursor) 的 BYOK 服务端修补成**可脱离 Cursor IDE 独立运行**的项目，封装为 Docker 镜像（linux/amd64 + linux/arm64）。

`cursor-agent` CLI（或任意 ConnectRPC 客户端）指向它，就能用自己的 LLM API Key（Anthropic / OpenAI / Gemini / 任意 OpenAI 兼容端点）跑完整 Agent 流程，不需要 Cursor 订阅。

```
cursor-agent CLI ──HTTP──▶ cursor-byok 容器 (:8630)
                              ├─ Fastify + ConnectRPC（27 个服务，含 CLI 模型目录补丁）
                              ├─ LLM 路由 → 你在 providers.json 里配的上游
                              └─ 会话持久化 SQLite + 配置热加载
```

- 上游源码原样放在 `vendor/CCursor`（CometixSpace/CCursor @ `fcac85d`）
- 独立运行补丁来自 [tangsong404/ccursor-cli](https://github.com/tangsong404/tangs-toolbox)（`patches/0001-cli-support.patch`：`node:sqlite` 替换 IDE 内置 sqlite、新增 CLI 模型目录 RPC）
- `src/standalone.ts` 额外修补了三处独立运行缺口：providers.json / routes.json **热加载 watcher**（原本由 IDE 扩展生命周期启动）、pino 日志镜像到 **stdout**（原本桥接 VS Code LogOutputChannel，独立模式下会丢）、**SIGTERM 优雅退出**

---

## 快速开始

```bash
docker compose up -d
curl http://127.0.0.1:8630/health     # {"ok":true,"mode":"byok"}
```

或直接用 GitHub Actions 推到 GHCR 的镜像（把 `<owner>/<repo>` 换成你的仓库）：

```bash
docker run -d --name ccursor-byok -p 8630:8630 -v ccursor-config:/home/node/.ccursor ghcr.io/nookmux/ccursor-byok:latest
```

---

## 一、CLI（cursor-agent）怎么配

两步，配一次即可：

**1. 环境变量 `CURSOR_API_ENDPOINT` 指向本服务**

```bash
# Linux / macOS（CLI 与容器同机）
export CURSOR_API_ENDPOINT=http://127.0.0.1:8630
# 跨机器时换成服务器 IP，如 http://192.168.1.10:8630
```

Windows（PowerShell 持久化）：

```powershell
[Environment]::SetEnvironmentVariable('CURSOR_API_ENDPOINT', 'http://<服务器IP>:8630', 'User')
```

**2. `~/.cursor/cli-config.json` 强制 agent 通道走 HTTP/1.1**

agent 通道默认走 HTTP/2，本服务是 HTTP/1.1，不改会连不上：

```json
{
  "network": {
    "useHttp1ForAgent": true
  }
}
```

之后正常使用 `cursor-agent`：登录态由本服务伪造（`/auth/*` stub），模型列表自动来自你配置的 `providers.json`，默认模型取其中 `defaultOn: true` 的那个。

## 二、环境变量改什么

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BYOK_HOST` | `0.0.0.0` | 容器内监听地址，保持 `0.0.0.0`，否则宿主机访问不到 |
| `BYOK_PORT` | `8630` | 容器内监听端口；改了的话 compose 里端口映射右侧要同步改 |
| `CURSOR_API_ENDPOINT` | （客户端） | 指向服务地址，见上一节 |

默认端口选了 **8630**：4 位、未注册常用服务，避开 3000/3306/5432/6379/8080/9000/9200/11434 等开发运维端口。宿主机端口冲突时只改 compose 里映射的左边：`- "9001:8630"`。

## 三、配置文件写什么

容器内全部状态在 `/home/node/.ccursor/`（compose 已挂 named volume `ccursor-config`）：

| 文件 | 怎么来的 | 要不要写 |
|---|---|---|
| `providers.json` | 首次启动生成空模板 | **必须配**，写上游 LLM 与模型 |
| `routes.json` | 首次启动自动生成 | 不用动（`byokMode: 1` 即 BYOK 开启） |
| `cursor.db` | 自动生成 | 不用动（会话持久化 SQLite） |
| `logs/` | 自动生成 | 不用动（agent 请求日志落盘） |

**providers.json 示例**（Anthropic 官方 + OpenAI 兼容中转各一个）：

```json
{
  "$schemaVersion": 1,
  "providers": [
    {
      "id": "my-anthropic",
      "name": "Anthropic",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "auth": { "kind": "apiKey", "value": "sk-ant-xxx" },
      "models": [
        {
          "id": "claude-sonnet-4-5",
          "apiModel": "claude-sonnet-4-5",
          "displayName": "Claude Sonnet 4.5",
          "thinking": true,
          "thinkingLevel": "medium",
          "contextTokenLimit": 200000,
          "defaultOn": true
        }
      ]
    },
    {
      "id": "my-relay",
      "name": "OpenAI 兼容中转",
      "type": "openai-chat",
      "baseUrl": "https://your-relay.example.com/v1",
      "auth": { "kind": "apiKey", "value": "sk-xxx" },
      "models": [
        {
          "id": "gpt-5",
          "apiModel": "gpt-5",
          "displayName": "GPT-5",
          "contextTokenLimit": 400000
        }
      ]
    }
  ]
}
```

字段说明：`type` 取 `anthropic` / `openai-chat` / `openai-responses` / `gemini`；`apiModel` 是上游真实模型名，`id` 是 cursor-agent 里显示的模型 ID；`defaultOn: true` 的那个成为 CLI 默认模型。

**写入方式**（任选其一，改完**即时生效**，不用重启容器）：

```bash
# 方式 1：docker cp
docker cp providers.json ccursor-byok:/home/node/.ccursor/providers.json

# 方式 2：bind mount 预先放好（compose 注释里有，宿主机目录属主需为 uid 1000）
# - ./data/.ccursor:/home/node/.ccursor
```

> 注意：bind mount 的宿主机目录要 `chown -R 1000:1000 ./data/.ccursor`（容器以 node 用户 uid 1000 运行）；named volume 无此问题。

---

## 镜像构建与 CI

- `Dockerfile`：两阶段构建——builder 装依赖、应用补丁、esbuild 打包成单文件 `server.cjs`；runtime 只带 Node 24 + 产物，非 root 运行，内置 `HEALTHCHECK`（`/health`）。基础镜像按 digest 固定；构建时传 `--build-arg BYOK_VERSION=<git sha>` 可把版本号烙进产物（`docker logs` 启动行与 `/health` 可见），不传则回退包版本。
- `Dockerfile.ci`：CI 专用——只 `COPY` 预构建好的 `server.cjs`，不再在镜像里跑 npm/esbuild。`server.cjs` 是纯 JS、supermarkdown 自带全平台二进制，镜像内容与架构无关，唯一的架构差异是底镜像。
- `.github/workflows/docker.yml`（结构借鉴 NookMux）：
  - `bundle`：server.cjs **只构建一次**（esbuild 产物架构无关），经 artifact 下发给各架构任务；
  - `build-single-arch`：每架构独占一个 runner 并行构建，推送 per-arch tag（`<tag>-amd64` / `<tag>-arm64`）。公开仓库 arm64 用**免费原生 runner**（`ubuntu-24.04-arm`），不走 QEMU 模拟；仓库转私有后可设 `DOCKER_ARM64_QEMU_FALLBACK=true` 回退；
  - `create-manifests`：`imagetools create` 把两架构合成多架构 manifest，并用 cosign 无密签名其 digest（带 provenance + SBOM attestation）。
  - 发布仍是 push 触发：push `main` → `latest`，打 `v*` tag → 同名 tag；每次发布额外打**不可变回滚 tag** `YYYYMMDD-<sha7>`；PR 只构建不推送；所有 action 按 release commit SHA 固定。

## 本地开发（不用 Docker）

```bash
npm run bootstrap        # vendor 依赖 + 应用补丁 + 打包 dist/server.cjs
BYOK_HOST=127.0.0.1 BYOK_PORT=8630 node dist/server.cjs
npm run cli              # TUI：管理 providers、本地守护进程启停（来自 ccursor-cli）
```

## 许可与致谢

AGPL-3.0-or-later。上游：[CometixSpace/CCursor](https://github.com/CometixSpace/CCursor)（Cursor++）、[tangsong404/ccursor-cli](https://github.com/tangsong404/tangs-toolbox)（独立运行补丁）。
