# 架構與故障邊界

## 定位

KAI Work Host 的直接使用者是 WebGPT Sol；真正通用 KAI Harness 的直接使用者是機器擁有者。兩者共享 KAI 的設計理解，但這個 Host 是獨立 repository 與 deployment unit，避免讓刻意固定版本的通用 KAI 被 WebGPT 接線需求牽動。

```text
WebGPT Sol
  → MCP
KAI Work Host orchestration
  → DSH SDK JSON-RPC
DSH remote-worker Profile
  → openai-codex subscription OAuth
Luna
  → registered local project
```

| 層 | 唯一責任 |
|---|---|
| WebGPT Sol | 高階規劃、取捨、驗收、追問與重大決策 |
| KAI Work Host | Host／Project／Task、逐回合指令保真、request 去重、三層記憶、路由、復原、receipt |
| DSH | AgentLoop、named Session、event、工具、檔案 sandbox、模型 adapter |
| Luna | 專案內讀寫、命令、測試、簡潔回報；不另立高階策略 |
| 正式專案 | 程式碼、規格與自己的正式真值 |

「薄」是沒有第二個高階認知層，不是缺少可靠的執行管理。

## Codex 邊界

唯一保留的 Codex 關係是 Luna 模型的 `openai-codex` 訂閱 OAuth 與推論協議。Host 不依賴：

- Codex App UI 或 task。
- `codex` CLI process。
- Codex App Server thread／turn API。
- Codex App 的 `CODEX_HOME`、歷史、設定或本機登入。
- OpenAI API key 或 API 計費 fallback。

worker 會移除可能繼承的 Codex/API 環境變數，並要求目前 instance 的 `<state-root>\dsh` 自己持有 `llm-pi-ai/openai-codex`、`kind: grant`。沒有這筆 grant 就在呼叫模型前 fail closed。

目前 `openai-codex` route 由固定 DSH checkout 裡的 pi-ai adapter 實作。這可證明產品執行鏈不需要 Codex App／CLI，不能自行升格成 OpenAI 對第三方 client 或合規性的保證。

這個 profile 是執行編排替代方案，不是 usage-limit 規避方案。WebGPT 的使用量與 Luna 的 Codex 使用量仍由各自服務計量；任何 provider limit 都必須 fail closed，不能以帳號輪替、provider reroute、API-key fallback 或重播 Task 規避。OpenAI 現行條款禁止繞過 rate limits／restrictions；Codex 官方說明要求到達上限後依使用量頁面提供的加購、reset、升級或等待選項處理。

## DSH Profile

KAI Work Host 在隔離的 DSH home 產生 `kai-work-host` Profile overlay，DSH checkout 本身保持唯讀。

Runtime 同時核對 `0.1.1-rc.2` 與 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`；不符合就 fail closed，不會把「路徑相同」誤當成「底座相同」。

Host config 的 worker model 是預設值，worker effort 同時是預設值與上限。WebGPT 每一回合可選 Luna-family model、上限內 reasoning effort 與 fast mode；DSH profile 的預設模型與 worker process 都讀同一份 model／effort 選擇。若同一 named Session 要改 model／effort，Host 只會在既有 worker idle 時關閉並重建 DSH worker，再 resume 同一 Session，避免用舊 runtime 設定吞掉 WebGPT 的指令。`fast` 只控制 KAI context 壓縮與回證，不是 DSH process 身分。

保留：

- base AgentLoop、Session JSONL、event、model adapter。
- PowerShell、檔案讀寫／搜尋、todo、token meter、compaction、tool-result pruning。
- `read-only`、`workspace-write`、`danger-full-access` 檔案模式。
- SDK JSON-RPC server。

關閉：

- 本地主 Planner、Goal、Plan mode、skills、commands。
- 子代理、workflow、background jobs。
- web search、browser、computer-use。
- telemetry 與 LLM session title。
- approval／question 互動通道。

權限互動通道關閉後，Profile 會明確提供三個 `sandbox + approval=never` 預設。這避免 DSH 只載入部分外掛、卻把後續「沒有模型 route」誤判成 adapter 故障。

## Durable identity 與 process

```text
Host
└─ Project（canonical root＋允許的 permission profiles）
   └─ Task（goal／acceptance／constraints＋request ledger）
      ├─ fixed DSH named Session
      ├─ one worker process while active
      ├─ Run / turn records
      ├─ monotonic event sequence
      └─ context／runtime events／diff／receipt artifacts
```

- 同一 Task 的 follow-up 沿用 Session；DSH process 重啟時 resume durable log，不重新建立同名空 Session，也不重新貼完整歷史。
- 同一 request id 的網路重試只回傳既有結果。
- `codexluna_start` 在呼叫 DSH 前先 durable reserve request fingerprint、固定 route、base Task 與 job id；若 Host 在 DSH 接受後、compat job attach 前退出，相同內容可接回原 run，不同 prompt 不得冒充或插隊。
- 不同 Task 各自一個 process，避免 cwd、權限與中斷互相污染。
- process 正常存活時可以多輪；Host 關閉時逐一 shutdown。`activeTaskProcesses` 只計 live worker 且有 in-flight run；完成／失敗後為了沿用 named Session 而 idle 的 worker 不算 active。
- HTTP 與 stdio production 入口都先取得依 state root 衍生的本機 OS lease；同一 `KAI_WORK_HOST_HOME` 同時只能有一個寫入者，避免兩個 process 各自用舊 snapshot 覆蓋三層記憶或 compatibility state。

## 三層仿生記憶與 token 控制

| 層 | 真值來源 | 取用方式 |
|---|---|---|
| L0 | 當前 durable Task、權限、狀態、最近結果 | 第一輪即時編譯 |
| L1 | 已結束 run 的結果、驗證、artifact 與事件範圍 | 依任務關鍵字＋新近度取最多 4 筆 |
| L2 | 明確寫入、有 evidence refs 的決策／限制／環境／架構事實 | 去重後依相關性＋新近度取最多 8 筆 |

`KAI_WORK_HOST_CONTEXT_CHARS` 預設是 12,000 字元；`fast=true` 時 KAI 會把第一輪 capsule 壓到最多 8,000 字元。這裡的 fast 是 KAI compact-context runtime mode，不是 provider 的快速模型 tier。Project、L0、每一筆 L1/L2 都有獨立區段上限；完整 snapshot 與 digest 留在 artifact，Luna 只收到有界內容。後續 follow-up 只送新增指令，讓 DSH Session 承接先前對話，避免每輪重灌記憶。

L1 只在 run 結束後寫入；L2 不會由 Luna 回答自動升格。這讓「記得更多」不會變成「每輪塞更多 token」。Receipt 的 `usage.incremental` 是該 run 的輸入／輸出增量：`inputTokens`（亦以 `uncachedInputTokens` 明示）是未快取輸入，另列 `cachedInputTokens`、`cacheWriteInputTokens`、`outputTokens` 與 `totalTokens`。`usage.cumulative` 是 Host 對各 run 增量的 task 累計，不把 provider cumulative snapshot 再加一次；明示 snapshot 另存 `providerCumulative`。

Runtime diagnostics 會記錄 usage event 數、prompt 字元數、tool call/result 數與 context window。沒有明示 cumulative 標記的 DSH usage event 按 provider 每次回應的 incremental usage 相加；因此若小任務得到 52,784／57,822，這些 provider 回應數字會保留，不能用較小的猜測值取代。只有明示 snapshot 才做 delta，避免把同一 cumulative usage 跨 event／turn 重加；`usage.cumulative` 仍是 Host task 累計。DSH 協定沒有 session history、tool schema 或 context-section 的 token attribution，因此這三項保留為 `null`，不以估算冒充 provider 數字。

## Task 狀態與復原

```text
queued → starting → running → completed / failed
                         ├→ interrupted
                         └→ needs_resume

needs_resume → recover（只讀對帳，replayed=false）
             → explicit follow-up（同一 named Session）
```

DSH SDK 沒有安全的 live steer、approval 或 question round-trip；因此：

- active turn 只能 wait 或 interrupt。
- follow-up 一律是 turn 結束後的新 turn。
- 程序退出、timeout 或 Host restart 時，不推測模型到底執行到哪裡，也不自動重送 prompt。
- `recover` 只讀回 durable binding；WebGPT Sol 必須先要求 Luna 檢查 workspace 現況再繼續。

這是 at-most-once model-turn policy，用來避免檔案修改或命令重複執行。

## 權限與限制

- Project root 必須精確登錄；不能用磁碟根、使用者 home 或多專案母目錄代替。
- Project 決定可用 permission profiles，Task 不能擴權。
- 每一 turn 保存 `web_session_id／project／workspace／permission／network／model／effort／fast／timeout／request_id` 的有效值；送進 Luna 前重寫並讀回 DSH sandbox，status／receipt 回報同一份值。不一致就明確失敗，不沿用舊值。
- `codexluna_init` 也有 durable request ledger；同一 conversation 的既有 binding 是 create-once，不接受新 request ID 改寫。init 與 start 共用 process 內 conversation lock，state-root OS lease 再阻止跨 process 覆寫。
- direct tools 也使用同一 conversation binding；讀工具可主動降權，寫／terminal 不得超過當前 binding，terminal job 不能跨 conversation 接手。
- `network=false` 目前是模型／任務政策，不是 OS firewall；狀態固定回報 `model-policy-only`。
- `danger-full-access` 若未同時授權 network 會被拒絕，避免宣稱不存在的網路隔離。
- push、部署、發布、傳訊與外部系統異動不會因檔案權限而自動取得授權。
- browser、computer-use、視覺標註與模擬器控制不做多跳模擬，仍使用原生 Codex 路徑。

## Windows durable write

Task snapshot 採 transaction marker＋event sequence 去重＋同目錄原子替換。Windows 覆蓋受阻時使用同目錄 backup rotation；重啟會先完成殘留 transaction，再決定是否進入 `needs_resume`。receipt path 與 terminal transition 同一筆 durable 更新落地。
