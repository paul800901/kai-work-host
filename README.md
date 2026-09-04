# KAI Work Host

[English](README.en.md) | 正體中文

KAI Work Host 是獨立的 WebGPT → 本機 Luna 執行腳手架。WebGPT Sol 負責高階判斷；KAI Work Host 透過 MCP 接收工作，用 DSH 管理本機 Session、工具與執行，再讓 Luna 完成一般程式專案工作。

公開 repository：<https://github.com/paul800901/kai-work-host>。CI 狀態以 GitHub Actions 的 `CI` 與 `Pinned DSH contract` workflow 為準：<https://github.com/paul800901/kai-work-host/actions>。

```text
Machine owner / operator
  ↕
WebGPT Sol（唯一高階規劃者）
  ↕ MCP
KAI Work Host（Host／Project／Task、L0/L1/L2、復原、回證）
  ↕ DSH SDK JSON-RPC
DSH remote-worker Profile（Session／AgentLoop／工具／sandbox／事件）
  ↕ openai-codex OAuth
Luna（本機執行 worker）
  ↕
已登錄的本機程式專案
```

## 依賴邊界

這個版本不啟動、不呼叫也不讀取 Codex App、Codex CLI 或 Codex App Server。只有 Luna 的登入與模型請求沿用 `openai-codex` 訂閱 OAuth 協議；其餘 Host、記憶、任務、工具、Session、復原與 MCP 都由 KAI Work Host＋DSH 承接。

- 獨立 OAuth grant 只存於目前 instance 的 `<state-root>\dsh\.credentials.yaml`。
- worker 啟動前會移除繼承的 `CODEX_HOME`、`OPENAI_API_KEY`、組織與 API project 環境變數。
- 沒有獨立 grant 時，Host 會拒絕付費 Luna turn，不會借用 Codex App 登入或改走 API key。
- `openai-codex` 是目前固定 DSH/pi-ai adapter route。這是本機整合邊界，不應描述成繞過額度或官方保證的第三方用法。
- KAI Work Host 只改變工作分工，不增加、重設或規避 Codex allowance。若 provider 回報使用上限，Task 必須停止並把錯誤回傳；不得輪替帳號、改 provider、借 API key 或用自動 fallback 繼續。可用的後續選項以 OpenAI 使用量頁面顯示者為準。

## 已實作

- 獨立 Host 身分、Project Registry、durable Task 與 request idempotency ledger。
- 一個 Task 對應一個 DSH process 與固定 named Session；follow-up 沿用同一個 Session。
- WebGPT Sol 是唯一決策權威；Luna 預設 `gpt-5.6-luna`／`high`，且每回合可由 WebGPT 指定 Luna-family model、上限內 reasoning effort 與 fast mode；沒有 provider fallback、本地主 Planner 或子代理。
- KAI 三層仿生記憶：L0 durable 現況、L1 帶事件範圍的工作經驗、L2 帶證據引用的長期事實。
- 第一輪才編譯有界 context capsule；後續 turn 只送增量指令，利用 DSH Session 保留上下文，降低重複 token。
- wait、follow-up、interrupt、重啟對帳、diff、精簡事件、usage 與逐輪 execution receipt。
- receipt 的 usage 明確分開每輪 incremental `inputTokens`（未快取輸入）、`cachedInputTokens`、`outputTokens` 與 `totalTokens`；若 DSH 明示 provider cumulative snapshot，Host 只記錄 snapshot delta。
- 不確定 turn 採 at-most-once：程序中斷後轉 `needs_resume`，不會靜默重播。
- 每個 Luna turn 都保存並回讀 WebGPT 指定的 workspace、permission、network policy、model、reasoning effort、fast、timeout 與 request identity；DSH process 重啟後會 resume 同一 named Session，再套用該回合 sandbox。model／effort 改變時會在 worker idle 後重建 DSH worker，但保留同一 named Session；`fast` 只控制 KAI context 壓縮，不重建 worker。
- direct file／terminal 工具綁定目前 WebGPT conversation；不能跨 conversation 操作 terminal job，也不能透過 junction／symlink 逃出 workspace。
- 18 個 WebGPT 公開 MCP 工具；底層另有 1 個只供 App widget 使用的私有 restore 工具。HTTP 與 stdio 兩種入口共用同一份工具契約。
- 真實 DSH SDK/Profile/Luna route 的 keyless 啟動探針；不登入、不呼叫模型。

刻意不提供 browser、computer-use、web search、子代理、部署、發布、Git push 與外部傳訊。這些需求回到原生 Codex 工作流或另行明確授權的專用工具。

## 專案隔離

```text
<source-root>                                 # 本專案 source／Git
<base-root>\app\0.3.1                        # 已安裝程式
<base-root>\instances\<instance-id>          # runtime、Task、記憶、receipt
<base-root>\instances\<instance-id>\dsh      # 獨立 DSH profile、Session、OAuth grant
<base-root>\dependencies\DeepSeekHarness-*   # 固定且唯讀的 DSH 底座
```

KAI Work Host 是 KAI 概念上的 `remote-worker` mode，但工程、版本與部署由這個獨立 repository 承接。它不複製第二套 AgentLoop。啟動時會核對 DSH 版本 `0.1.1-rc.2` 與 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，避免固定路徑被其他更新悄悄替換。

## 安裝與 keyless 驗證

需求：Node.js 24 以上，以及 Git。Windows 部署器可取得並 build 固定 DSH checkout；也可明確提供已 build 的精確 checkout。

```powershell
git clone https://github.com/paul800901/kai-work-host.git
cd kai-work-host
npm ci
npm run validate
```

`validate` 會跑型別、單元測試、production build、真實 DSH 無憑證啟動、HTTP 入口與 stdio MCP smoke；不會開 OAuth、不呼叫 Luna、不發布 connector，也不修改正式專案。

## 一次性 Luna 登入

```powershell
cd C:\path\to\kai-work-host
npm run auth:login
npm run auth:status
```

登入工具直接使用固定 DSH 的 `openai-codex` OAuth flow，預設開啟系統瀏覽器，完成後只回報 grant 類型，不輸出 token。已有 grant 時不重登；要明確重授權才使用：

```powershell
node scripts/login-luna-oauth.mjs --force
```

無法接收 localhost browser callback 時可改用 `node scripts/login-luna-oauth.mjs --device-code`。

## 啟動

本機 HTTP：

```powershell
npm run start
```

- MCP：`http://127.0.0.1:8787/mcp`
- health：`http://127.0.0.1:8787/healthz`

交給 Secure MCP Tunnel／其他 stdio connector：

```powershell
npm run start:stdio
```

stdio 模式不開本機 HTTP 埠，stdout 只留給 MCP protocol。ChatGPT 網頁端的 custom MCP connector 建立、重新整理與發布仍是獨立操作；詳見 [操作與接線](docs/OPERATIONS.md)。

HTTP 與 stdio 入口會對同一 `KAI_WORK_HOST_HOME` 取得作業系統持有的單一寫入租約；第二個本機 Host 會在載入 durable state 前 fail closed。MCP stdin 關閉、SIGINT 或 SIGTERM 都會正常釋放租約。

一個 tunnel 只能由一個本機 runtime 承接。把 tunnel 切給 `kai-work-host` 前必須先停止共用該 tunnel 的舊通用 runtime，否則 ChatGPT 可能在 KAI 與通用 terminal schema 間漂移；切換後再於 developer mode 按「重新整理」。

正式受管啟動使用 `npm run tunnel:connect`。它只在 tunnel-client 子程序環境隱藏 Codex CLI，避免其可選管理介面拉起非必要的 `codex app-server` sidecar；不改全域 PATH，也不影響 Luna 的 `openai-codex` OAuth／模型 route。

## WebGPT 工具順序

1. 每個 ChatGPT conversation 先呼叫一次 `codexluna_init`，傳入機器擁有者指定的精確 workspace、必填 `permission_mode`、`network_access`、預設 worker 選擇與必填、一次性的 `request_id`；首次登錄建立 Project 上限，既有 Project 不會因後續 WebGPT 呼叫而自動擴權。同一 request 重試會回傳原 binding，不會重新套用；相同 ID 搭配不同設定會被拒絕。後續新 ID 只能讀回完全相同的既有 binding，不能覆寫目前 conversation。
2. 呼叫 `codexluna_start` 交付完整目標與必填 `request_id`。每一回合可直接指定不超過 Project 上限的 `permission_mode`、`network_access`、`timeout_ms`、Luna-family `model`、不高於 Host ceiling 的 `reasoning_effort` 與 `fast`；不需要先重跑 init。相同 conversation 沿用同一 DSH named Session，只送增量 follow-up。
3. 若 tunnel 回覆遺失，重試同一 start 時必須重用原 `request_id`。Host 在交給 DSH 前先 durable reserve 指令 fingerprint 與 job identity；相同內容接回原 run，不同內容 fail closed，未完成的舊 request attach 前不接受較新 start 插隊。terminal 執行也應提供一次性的 `request_id`。
4. 用 `codexluna_status` 取得有效權限、timeout、`needs_resume` 與結果；`mutation_observation=not_observed` 只代表 Host 沒收到 diff artifact，不等於證明磁碟完全沒變。status／cancel 應帶同一 `web_session_id`（若 ChatGPT 已提供 conversation metadata 可省略）。需要停止時用 `codexluna_cancel`，查看綁定用 `codexluna_session`。
5. 8 個 `file_*` 與 5 個 `terminal_*` 皆沿用目前 conversation 的 workspace／permission；不得自行指定更高權限或另一個 workspace。ChatGPT 附件匯入是獨立、origin-checked 的 `chatgpt-attachment-ingress`，不等同一般網路權限。

`network_access=false` 會原樣交給 Luna 並在每回合狀態回讀，但目前 enforcement 明示為 `model-policy-only`，不是 Windows firewall。Host 不會把這個政策冒充 OS 層網路隔離。

公開工具共 18 個。底層第 19 個 `file_image_preview_restore` 標成 App-private，只供預覽 widget 復原，不應出現在網頁版 GPT 的模型工具清單。

## 主要設定

程式直接讀 process environment，不會自動載入 `.env`。完整範例見 [`.env.example`](.env.example)。

| 變數 | 預設 | 用途 |
|---|---|---|
| `KAI_WORK_HOST_HOME` | `%LOCALAPPDATA%\KAI\WorkHost`（Windows） | 獨立 runtime root；部署器會改成 instance-specific root |
| `KAI_WORK_HOST_DSH_ROOT` | `<HOME>\dependencies\<exact-pin>` | 唯讀 DSH checkout |
| `KAI_WORK_HOST_DSH_HOME` | `<HOME>\dsh` | Profile／Session／OAuth grant |
| `KAI_WORK_HOST_DSH_PROVIDER` | `openai-codex` | 固定 Luna 訂閱 route |
| `KAI_WORK_HOST_WORKER_MODEL` | `gpt-5.6-luna` | 預設 worker model；WebGPT 每回合仍可選 Luna-family model |
| `KAI_WORK_HOST_WORKER_EFFORT` | `high` | 預設 reasoning effort，也是 WebGPT 每回合可選 effort 的上限 |
| `KAI_WORK_HOST_EXECUTION_PROFILE` | `lean` | 預設 fast mode 來源；另有 `standard` |
| `KAI_WORK_HOST_CONTEXT_CHARS` | `12000` | 第一輪完整 context capsule 上限；`fast=true` 時壓到最多 8000 |
| `KAI_WORK_HOST_BEARER_TOKEN` | 空 | 非 loopback HTTP bind 必填 |

架構、安全與部署分別見 [ARCHITECTURE.md](docs/ARCHITECTURE.md)、[THREAT_MODEL.md](docs/THREAT_MODEL.md) 與 [DEPLOYMENT_WINDOWS.md](docs/DEPLOYMENT_WINDOWS.md)。

## 參考

- [OpenAI：Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI：Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## 開源與發布

原始碼採 [MIT License](LICENSE)。`private: true` 只用來防止誤發 npm，不限制 MIT 授權下的使用、修改與散布。公開版本需從 clean Git commit/tag 產生；本機 East/South 等 deployment label 只會加入不含秘密的 instance installer，不會把 OAuth、tunnel key、專案路徑或記憶打包。詳見 [RELEASE.md](docs/RELEASE.md) 與 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`v0.3.1` 的同一個 GitHub Release 可以同時放通用資產與 East instance 資產：

- `KAI-Work-Host-0.3.1.zip` 與 `KAI-Work-Host-0.3.1.zip.sha256` 是通用公開套件。
- `KAI-Work-Host-East-0.3.1.zip` 與 `KAI-Work-Host-East-0.3.1.zip.sha256` 是同一 release 下的 East instance 便利安裝資產，只增加不含秘密的 `DEPLOYMENT_PROFILE.json` 與 `Install-East.ps1`；East 不是第三個 repository，也不是另一條 release。
