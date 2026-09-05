# 架構與故障邊界

## 唯一責任

| 層 | 責任 |
|---|---|
| WebGPT | 理解需求、決策、授權判斷與結果審視 |
| KAI Host | MCP、Project 上限、逐輪保真、request 去重、durable Task、回證 |
| 官方 Codex App Server | 執行 loop、thread／turn、工具、沙箱、訂閱登入 |
| Luna | 根據任務執行、讀取必要資料、回報證據；不取代高階策略 |

Host 不再依賴 DSH，也不建立自製模型適配器、記憶生成模型或第二個規劃層。

## 執行與持久性

每個 Task 最多一個當前 worker，使用固定 @openai/codex@0.153.3。stdio JSONL 只在父子程序間傳輸。執行環境移除繼承的 CODEX／OPENAI／DSH 設定並指定 KAI 專用 Codex home。獨立官方 ChatGPT 登入是模型執行前提。

thread/start 或 thread/resume 回讀選擇與權限後，先保存 thread ID，再送 turn/start。回應遺失不自動重播。空 thread 尚未執行第一輪時可能沒有可恢復的官方 rollout；不把空 thread 的建立當作 durable resume 驗證。

一個 state root 由一個 OS 租約保護。Task snapshot、事件、request ledger、diff 與 receipt 維持原有交易寫入方式。歷史 DSH binding 保留讀取，不允許轉成 Codex binding；需要新任務。

## 上下文

- L0 是 durable Task 狀態，不是額外送入模型的一份重複任務。
- 初始 capsule 只編譯明確 Project root／instructions；goal 與 constraints 在主指令提供一次。
- 不讀取 L1／L2，不自動生成 episode。既有資料不刪除。
- 後續送增量指令，由官方 thread 保持必要歷史。
- features.memories、memories.generate_memories、memories.use_memories 均關閉。
- 多代理、apps 與 web search 關閉；不另開模型補記憶或判斷。

必要 Project 指示超過字元上限時明確失敗，不截斷成不完整授權。官方基礎指示、工具 schema、任務內歷史與 compaction 仍有成本，不能承諾 token 免費或未測量的節省比例。

## 權限

Project 由操作人員選定的精確 root 與允許模式構成上限。每一輪保存並傳入 model、effort、cwd、sandbox、network、timeout；官方回讀不符便停止。request ID 相同但內容不同不予執行。

Luna 使用 read-only／workspace-write／danger-full-access。Windows 子程序明確使用 unelevated 沙箱；不靜默升權或改全域安全設定。Windows 禁網僅是政策／環境層約束，回報 model-policy-only，不是防火牆。danger-full-access 無法隔離網路，network=false 時拒絕。官方沙箱限制寫入並非全檔案讀取隔離。read-only 的 thread 初始化固定 offline，合法連網選擇由每輪明確 sandboxPolicy 傳入，不將檔案模式升為可寫。

MCP direct file 工具有 canonical path／junction 防逸出檢查；direct terminal 並不是 Codex 沙箱。發布、Git push、外部傳訊等授權不由檔案模式推導。

## 取消與復原

官方 turn/interrupt 的回應只證明收到取消，不證明所有 shell 已停止。實測曾發現回合已 interrupted，但長指令稍後仍写入。現在取消會在 ancestry 仍存在時終止該 Task 專屬程序樹；不終止其他 Task、Host 或 tunnel。thread 與執行紀錄保留，下一次明確續接會建立新的 worker。

worker crash 或不確定 dispatch 轉 needs_resume；操作者先檢查實際效果，再送增量 follow-up。未知不能當作零副作用；沒有 diff 也不能證明沒改檔。

## 用量

tokenUsage.total 是 provider 累計快照，不能逐事件直接相加。有可信基準才取差值；重啟後無基準／計數重置時 incremental=null。任何歷史回合用量未知，Task cumulative=null。保留 cached、uncached、output 與 provider snapshot；不把工具歷史 attribution 的猜測寫成事實。

## 通道

kai-work-host 是唯一正式 owner。監督器只觀察、不在健康檢查中 connect；已證實 Host/tunnel readiness 失敗才進入受管恢復。探針超時是 unknown，持續失聯需顯示異常而非永遠綠燈或直接殺程序。Luna job failure 不等於基礎設施死亡。

停止會等待在途觀察與恢復操作結束，並讀回正式 alias 的 stopped 狀態。PID／路徑／alias 以完整 argv 和程序祖先確認，不用子字串，拒絕 PID 0。Codex worker 與 tunnel 自行啟動的 sidecar 分開計數。

缺乏成功 MCP 證據時 functional health 保留 null；不得用沒有 log 的「未發現錯誤」覆蓋已知失敗。
