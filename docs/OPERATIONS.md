# 操作與接線

## 1. 安全前提

- Source：目前 Git checkout 或 release 的 `<source-root>`。
- Runtime：目前 instance 的 `<state-root>`。
- 固定且唯讀的 DSH：`config/dsh-pin.json` 指定的 exact checkout。
- OAuth grant、MCP bearer 與 tunnel key 不得進 repository、task prompt、memory 或 receipt。
- 只登錄機器擁有者明確指定的精確 Project root；不要登錄磁碟根、home 或多專案母目錄。

## 2. Keyless 驗收

```powershell
cd C:\path\to\kai-work-host
npm ci
npm run validate
```

驗證內容：

- TypeScript strict check、單元測試與 production build。
- fake DSH runtime 下的 durable Task、同 Session follow-up、usage、interrupt 與 crash recovery。
- 真實固定 DSH 的 Profile 組合、SDK JSON-RPC 初始化、預設 `openai-codex/gpt-5.6-luna` route 與 worker model 環境選擇；不登入、不送 prompt。
- 正式 HTTP health 與 stdio MCP 入口。
- raw `tools/list` 共 19 個，其中 `file_image_preview_restore` 為 App-private；網頁版 GPT 可見的公開工具必須正好 18 個，以及 `codexProductRuntimeUsed=false`。

這一步不消耗模型額度、不修改正式 Project，也不建立或發布 WebGPT connector。

## 3. 一次性獨立 OAuth

查看狀態：

```powershell
npm run auth:status
```

第一次登入：

```powershell
npm run auth:login
```

工具會使用 DSH/pi-ai 的 `openai-codex` OAuth flow，預設開啟系統瀏覽器。完成後只檢查：

```text
<state-root>\dsh\.credentials.yaml
└─ llm-pi-ai/openai-codex
   └─ kind: grant
```

不會輸出 access／refresh token。已有 grant 時 `auth:login` 是 no-op；只有明確要換帳號或重授權時才執行 `node scripts/login-luna-oauth.mjs --force`。

若 localhost callback 無法到達，可用 `node scripts/login-luna-oauth.mjs --device-code`，在頁面輸入終端顯示的一次性 device code。

這筆 grant 只服務 KAI Work Host。worker 會移除繼承的 Codex App/API 環境變數，因此不會把「這台機器已登入 Codex」誤當成「這個 Host 已授權」。

這筆 grant 不得用來規避 Codex 使用上限。provider 回報額度或 rate limit 時停止 Task 並回傳錯誤；不要換帳號、換 provider、借 API key 或無限重試。參考 [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) 與 [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540)。

## 4. 啟動

HTTP 模式：

```powershell
npm run start
```

成功時 stdout 只印一行 readiness JSON。DSH worker 是 lazy：第一個 Task 才開 process／Session。

stdio connector 模式：

```powershell
npm run start:stdio
```

或由 Windows connector 呼叫：

```text
<install-root>\scripts\start-stdio.ps1
```

這支啟動器只解析 `node.exe` 與 `dist\stdio.js`，不需要 `codex.exe`，也不保存 OAuth/token。

## 5. WebGPT 使用順序

1. `codexluna_init`：以必填、一次性 `request_id` 綁定目前 ChatGPT conversation、精確 workspace、必填 permission、network policy 與預設 worker 選擇；回傳必須帶回同一 request ID 並顯示 L0／L1／L2 已啟用。相同 request 重試回傳原 binding，相同 ID 搭配不同設定會被拒絕；新 ID 也不能覆寫已成立的 conversation binding。
2. `codexluna_start`：送完整 goal／acceptance／constraints 與必填 `request_id`，並可直接替該回合指定上限內的 permission、network、timeout、Luna-family model、reasoning effort 與 fast mode。相同 conversation 的後續 start 會成為同一 DSH Session 的增量 follow-up；model／effort 改變時 Host 會在 worker idle 後重建 worker 並 resume 同一 named Session。`fast` 只控制 KAI context 壓縮，不重建 worker。
3. 同一請求重試必須重用原 `request_id`。Host 會先 durable reserve 指令 fingerprint／route／job，再交給 DSH；中途重啟後相同內容接回原 run，不同內容拒絕，尚未 attach 的舊 request 也會阻止新 start 插隊。terminal 執行同樣應提供 `request_id`。
4. `codexluna_status`：帶同一 `web_session_id` 反覆查詢同一工作；未完成時不要用新 request id 重送 start。`mutation_observation=not_observed` 只表示沒有收到 diff artifact，不得解讀成磁碟必然未變。需要中止用 `codexluna_cancel`，查看綁定用 `codexluna_session`。
5. 需要 WebGPT 直接查看或操作 workspace 時，使用 8 個 `file_*` 與 5 個 `terminal_*`；它們綁定目前 conversation，不能升過 binding、改用另一個 workspace、跨 conversation 控制 terminal，或沿 junction／symlink 逃出 workspace。

沒有 `approve`、`answer` 或 live `steer` 工具。需要機器擁有者決定時，Luna 應停止並在結果中說明，WebGPT Sol 再送一個新 follow-up。

## 6. Session 與 recovery

- WebGPT conversation、Project、KAI Task 與 DSH named Session 的綁定會寫入目前 instance 的 `<state-root>`，Host 重啟後可恢復。
- HTTP 與 stdio 入口共用同一 state-root 單一寫入租約；直接啟動第二個 Host 也會在讀寫狀態前 fail closed。stdio 管道關閉或程序收到終止訊號時會釋放租約。
- DSH worker process 重啟後，KAI control adapter 會 resume 既有 named Session，先把該回合 permission 寫成 durable DSH event並讀回，再送 prompt；升權與降權都走同一路徑。
- active turn 不接受第二個 start；先等待 status 結束，或明確 cancel。
- `needs_resume` 會直接出現在該 job 的 status 與逐回合 error；由 WebGPT Sol 明確要求 Luna 先檢查 workspace／測試／diff 現況，再繼續工作，不得把原 prompt 原樣重送當自動 retry。

## 7. ChatGPT custom MCP

ChatGPT 網頁版要真正看到 18 個公開工具，仍需把 stdio runtime 掛到受管 tunnel／connector，並在 ChatGPT developer mode 重新整理。這是 Host 之外的連線層；不得只因本機 `npm run start:stdio` 成功就宣稱 WebGPT 端已更新。

同一個 tunnel 同一時間只能有一個本機 runtime 輪詢。不要讓舊的通用 `codex-chatgpt-web` runtime 與 `kai-work-host` 共用同一 tunnel；否則 connector schema 與實際 tool call 可能被不同程序接走，表現為工具數量漂移或 `Tool ... not found`。切換版本時應先停止舊 runtime、確認只剩一個 tunnel-client／stdio Host，再等待既有長輪詢失效後按「重新整理」。

正式受管啟動使用：

```powershell
npm run tunnel:connect
```

這支腳本會拒絕與仍在執行的舊同-tunnel runtime 競爭，並只在 tunnel-client 子程序環境移除 Codex CLI 路徑與 Codex/API 環境變數；Node、DSH 與 KAI stdio 仍保留。最後必須驗證單一 KAI Host、`process_running=true`、`ready=true`、`healthy=true`、目前程序實例的 MCP 記錄沒有連續 `client_internal/upstream_response_received=false` 或 response deadline，且 `codexProductSidecarCount=0`。只有外層 `/healthz`／`/readyz` 成功不能視為工具呼叫已正常。要受控重啟同一 alias 時使用 `npm run tunnel:connect -- -Restart`。

桌面啟動器若發現同一 tunnel 由 `kai-work-host` 別名持有，必須再讀該別名自己的 `process_running`、`ready`、`healthy` 與目前程序實例記錄，分成 `external-ready` 或 `external-degraded`；不得只因存在同 tunnel alias 就顯示已就緒，也不得在外部 KAI profile 異常時偷偷啟動舊 standalone runtime 取代它。

每次 schema 或 runtime 改版後，至少讀回：

- connector process health。
- ChatGPT 實際工具數量與名稱；v0.3 公開工具必須正好 18 個：5 個 `codexluna_*`、8 個公開 `file_*`、5 個 `terminal_*`。
- raw MCP 可列出第 19 個 `file_image_preview_restore`，但它必須保持 App-private，不得暴露給模型。
- `codexluna_init` 的 v0.3 runtime、Session 與 L0／L1／L2 邊界。
- `codexluna_init` schema 必須要求 `workspace_path`、`permission_mode` 與 `request_id`。

OpenAI 的 custom MCP connector 說明見：[Developer mode and full MCP connectors in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)。

## 8. 付費 smoke

付費 smoke 不屬於 `validate`。完成 OAuth 後，可先啟動 HTTP Host，再執行：

```powershell
npm run smoke:real:readonly
```

它只登錄目前 checkout 為 `read-only`、要求 Luna 讀 `package.json` 與 `README.md`，最後核對兩檔 SHA-256 未改。這能證明模型、DSH Session、工具、MCP、Task 與 receipt 全鏈；不能證明 workspace-write、網路隔離、connector 或正式專案安全。若要測逐回合 runtime selection，應優先用 fake runtime／keyless 測試；不要為 schema refresh 重複消耗付費 Luna turn。
