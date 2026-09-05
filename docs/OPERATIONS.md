# 操作與接線

## 安全前提

Source、已安裝程式、state、正式 Project 分開。只登錄明確 Project root；不登錄磁碟根、使用者 home 或多專案母目錄。token、tunnel key、auth.json 不得進 Git、prompt 或 receipt。

## Keyless 驗證與獨立登入

```powershell
npm ci
npm run validate
npm run auth:status
npm run auth:login
```

validate 不登入也不呼叫模型；涵蓋 TypeScript、request 去重／權限／狀態測試、真實 Codex stdio／沙箱／程序停止與 HTTP／stdio MCP smoke。若正式 Host 直接從開發目錄啟動，先在獨立候選目錄建置驗證。

登入由固定官方 Codex 的 account/login/start 管理。grant 存於 KAI_WORK_HOST_CODEX_HOME（預設 state-root/codex），不複製桌面或 DSH 憑證。已有 ChatGPT 登入時不重登；明確重授權才用 --force。無 localhost callback 時可選 --device-code。不要輸出 auth.json。

登入與實測是獨立授權動作。遇額度／帳號／模型限制時停止，不換 provider、帳號或 API key。

## 啟動

```powershell
npm run start
# 或交給 tunnel 的 stdio 模式
npm run start:stdio
```

HTTP 預設 127.0.0.1:8787/mcp 與 /healthz。stdio 不開 HTTP 埠，stdout 只提供 MCP。相同 state root 只容許一個 Host。worker 按任務建立，啟動 Host 不觸發 Luna 模型。

## WebGPT 流程

1. codexluna_init：必填 workspace_path、permission_mode、request_id；指定 model／effort／network。只建立一次 conversation binding，不覆寫既有授權。
2. codexluna_start：送指令與穩定 request_id；重試同一指令使用原 ID，不另開新回合。
3. codexluna_status：追蹤同一 job。needs_resume 表示需先確認副作用，再明確續接。
4. codexluna_cancel：只停止該 task worker；公開狀態為 cancelled，底層 Task 為 interrupted。保留官方 thread 與紀錄。
5. file_*／terminal_*：使用同一 conversation 與 workspace；不得接管他人 job。

記憶旗標為 L0=true、L1=false、L2=false。L0 僅代表持久 Task。沒有 live steer／互動批准工具；需要新決策就停止並交回 WebGPT。不得把未觀察到 diff 當作沒修改磁碟。

## 通道與監督器

```powershell
# 僅觀察，絕不 connect、停止程序或修改 profile
.\scripts\connect-managed-tunnel.ps1 -ObserveOnly
# 初次受管連線（需已配置正式 profile）
npm run tunnel:connect
# 明確受控恢復
npm run tunnel:connect -- -Restart
```

正式 alias 固定 kai-work-host。1 tunnel／1 KAI Host／0 tunnel-created sidecar；由 Host 建立的 Codex execution children 另計，並非第二個 owner。腳本只在 tunnel 子環境隱藏全域 Codex CLI，不更動系統 PATH；Host 使用安裝目錄的固定 CLI。

ObserveOnly 在任何 stop／connect／TTL 寫入之前返回。健康證據分開：程序／拓撲、tunnel readiness、MCP functional health。缺 log 或沒有成功 MCP 證據時最後一項為 null，不顯示成已證實成功，也不覆蓋其他來源的 false。

監督器持續觀察正式 owner。已證實 readiness 失敗達門檻時恢復；未知探針結果持續時顯示異常但不擅自拆通道。Luna 任務失敗不 teardown Host。停止等待在途探針與恢復操作，讀回 alias stopped 後才宣稱退出。UI 狀態由監督器即時推送。

同一 tunnel 不可被 Standalone 和 KAI 競爭。不得自行 setup WebGPT Luna Standalone。更換 schema／runtime 後，在 ChatGPT developer mode 重新整理並讀回 18 個公開工具；第 19 個 restore 必須維持 App-private。本機通過不代表 WebGPT connector 已更新。

## 遷移

先安裝候選，保留舊安裝與 state。驗證後在維護窗口將正式 profile 的 stdio command 指向已驗證的安裝目錄，保留 alias 與金鑰；停止舊 owner、啟動新 owner、讀回實際 PID／健康／拓撲。發生錯誤回復舊 command 與安裝，不搬移或刪除舊 state。

舊 DSH thread 無法由 Codex 繼續。需新 conversation／明確新任務；不自動匯入歷史，不重播未確定回合。

舊 KAI_WORK_HOST_DSH_* 與 KAI_WORK_HOST_MAX_OUTPUT_TOKENS 設定不再生效；後者不是官方 App Server 的輸出上限參數。不得用該舊設定承諾 token 或費用上限。

## 授權實測

scripts/smoke-codex-authorized.mjs 不包含在 validate／CI。--authorized-three-turns 僅供明確授權的 3 輪隔離測試；--authorized-cancel-retest 需額外 1 輪授權。每次使用精確 --root 與 KAI_WORK_HOST_CODEX_HOME，marker 防止重跑不確定測試。這是人員授權後的操作工具，不是自動輪替或付費 retry 機制。

驗收要看實際檔案、同一 thread、取消後沒有延遲寫入、Host 健康與 direct MCP 是否仍可使用。保存失敗證據，不用後來成功覆蓋它。
