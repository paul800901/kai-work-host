# KAI Work Host

[English](README.en.md) | 正體中文

KAI Work Host 0.4 是 WebGPT 到本機的薄型 MCP／任務橋接層。WebGPT 負責需求、決策、授權判斷與結果審視；KAI 保真傳遞與保存工作；Luna 透過固定版本的官方 Codex App Server 執行。

```text
WebGPT → Secure MCP Tunnel → kai-work-host → Codex App Server（stdio）→ Luna／本機工具
```

不再使用 DSH，不建立第二個本地規劃模型，也不自動注入 L1／L2 跨任務記憶。舊任務與記憶檔案保留，不會自動改寫或重播。

## 實作邊界

- 唯一正式 tunnel owner 為 `kai-work-host`。維持 1 tunnel、1 KAI Host、0 tunnel 自行啟動的 Codex sidecar；執行任務時由 Host 建立的 Codex 子程序不是第二個 owner。
- 執行底座固定為 `@openai/codex@0.153.3`，經本機 stdio 通訊，不依賴桌面 Codex UI。啟動時核對實際版本。
- KAI 使用自己目錄內的官方 ChatGPT 登入；不複製桌面／DSH 憑證、不使用 API key、不切換 provider 或模型作為 fallback。
- 一個 KAI Task 綁定一個官方 thread。thread ID 先落地，再送模型回合；Host 重啟後續接既有 thread，不重送完整歷史。不確定回合轉為 `needs_resume`，需要明確增量指令。
- 每回合核對 model、effort、workspace、approval 與 sandbox。超出 Project 上限、不支援的選擇或權限不一致會停止。
- 取消會停止該任務專屬的 Codex 程序樹，保留 thread／receipt；任務失敗不關閉 Host 或 tunnel。
- 初始上下文只有明確的任務與 Project 指示；後續只有增量指令。KAI 不自動產生或檢索跨任務記憶，Codex memories 的產生與使用亦關閉。
- 保存 request 去重、逐輪事件、diff、usage 與結果。相同 request ID 的重試不再執行一次。
- 保留 18 個公開 MCP 工具，另有 1 個 App-private 圖片預覽復原工具。

官方 thread 歷史、工具描述及模型自身基礎指示仍會佔用 token。這不是零成本通道，也不保證比舊版便宜。usage 無可靠基準時保留 null，不以猜測補值；任一歷史回合用量未知，整個 Task 累計亦未知。fast 只是 KAI 精簡模式，不啟用加價服務 tier。

## 安裝與驗證

需求：Windows、Node.js 24+、PowerShell、Git／npm 網路。固定 Codex 套件隨 npm 安裝，不需建立 DSH checkout。

```powershell
git clone https://github.com/paul800901/kai-work-host.git
cd kai-work-host
npm ci
npm run validate
```

validate 僅執行型別、測試、建置、公開檔案檢查、原生 Codex keyless 沙箱／停止子程序驗證及 HTTP／stdio smoke。不登入、不呼叫模型、不建立 tunnel、不修改正式專案。不要對正式 Host 正在使用的開發目錄直接建置；先在獨立候選目錄驗證。

安裝、登入與通道設定分別見 [Windows 部署](docs/DEPLOYMENT_WINDOWS.md) 與 [操作接線](docs/OPERATIONS.md)。

## WebGPT 工具順序

1. codexluna_init：指定精確 workspace、permission_mode、network_access 與穩定 request_id；回傳記憶旗標 L0=true（持久任務狀態）、L1=false、L2=false。
2. codexluna_start：送指令與唯一 request_id；可在 Project 上限內指定該輪權限、Luna model／effort、timeout。
3. codexluna_status：查同一 job，不用新 request 重送未完成指令。需要中止時使用 codexluna_cancel；公開狀態為 cancelled。
4. file_*／terminal_* 綁定同一 conversation。不得拿其他 conversation 的 job 或 workspace 來操作。

升權、發布、Git push、外部傳訊等需要獨立授權；本 Host 不推論授權，也不提供瀏覽器或 computer-use 的模擬替代。

## 隔離與限制

KAI 檔案工具會檢查 canonical path 與 junction／symlink。Luna 使用 Codex 沙箱，Windows 預設只在子程序設定 unelevated restricted-token 模式，不改全域安全設定；它限制寫入，但禁網僅是政策／環境層約束，不是防火牆；實測原生程式仍能連網。因此 Windows 回報 model-policy-only。它並非完整虛擬機，也不禁止所有外部讀取。直接 terminal 工具不是 Codex 沙箱，不能把其 network_access 政策當作防火牆。詳見 [威脅模型](docs/THREAT_MODEL.md)。

舊 DSH Session 不能續接為 Codex thread。升級後請建立新的明確範圍任務／conversation；不要自動匯入完整歷史。舊 state、grant 與紀錄原樣保留。

## 主要設定

程式讀 process environment 與安裝器產生的 config/work-host.local.json，不自動讀 .env。

| 變數 | 用途 |
|---|---|
| KAI_WORK_HOST_HOME | instance 獨立狀態目錄 |
| KAI_WORK_HOST_CODEX_HOME | 獨立登入／thread 目錄，預設 state-root/codex |
| KAI_WORK_HOST_CODEX_CLI | 預設本安裝目錄 node_modules 內的固定 CLI |
| KAI_WORK_HOST_WORKER_MODEL | 預設 gpt-5.6-luna |
| KAI_WORK_HOST_WORKER_EFFORT | 預設 high，亦為上限 |
| KAI_WORK_HOST_CONTEXT_CHARS | Project 指示的字元上限；超長不會靜默截掉必要指示 |
| KAI_WORK_HOST_BEARER_TOKEN | 非 loopback HTTP 必填，不得提交 |

## 發布

[GitHub](https://github.com/paul800901/kai-work-host) 的同一版 release 可提供通用 ZIP 與 East ZIP。East 只是無秘密的安裝標籤，不是另一套來源；東區必須使用自己的 tunnel、金鑰、登入與 state。來源、安裝版本、正式通道是否切換、網頁端是否讀回成功，是不同完成狀態。

本專案採 [MIT](LICENSE)，官方 Codex 採 Apache-2.0，詳見 [第三方聲明](THIRD_PARTY_NOTICES.md)。本整合不是 OpenAI 產品或服務保證。

參考：[App Server](https://learn.chatgpt.com/docs/app-server)、[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[memories](https://learn.chatgpt.com/docs/customization/memories)、[架構](docs/ARCHITECTURE.md)、[發布程序](docs/RELEASE.md)。
