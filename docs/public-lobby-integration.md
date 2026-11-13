# 公共大厅接线与审查

大厅注册表在 `game/server/lobbyRegistry.ts`，共享类型、请求解析与昵称清理在 `game/shared/lobby.ts`。提交 `354be19`、`1e88ba5`、`0755681` 已包含大厅协议、服务端与测试基础；`cda9919` 为 UI 切片，包含 `game/client/index.html`、`game/client/src/lobby.ts`、`game/client/src/lobby.css`、`game/client/src/main.ts` 与 `game/tests/unit/lobby_client.test.ts`；`30536b9` 补齐建房容量异常兼容修复及其回归，`800b675` 补齐真实联机测试与接线交接。UI 接线由 `main.ts` 引入大厅控制器和样式，连接页面控件及消息/断线钩子；与重连分支合并时按下文保留其恢复流程。本地验证的实际结果见下文；合并验证、部署与公网复验仍由集成代理负责。

## 与重连分支合并

`0755681` 对共用文件的必要修改如下。应逐个移植最小 hunk，不能用该提交的整个 `server/index.ts`、`shared/protocol.ts` 或 `server/room.ts` 覆盖目标分支，否则会丢失目标分支的重连、心跳和连接限额修改。

| 文件 | `0755681` 的接线 |
| --- | --- |
| `game/server/index.ts` | 导入 `LobbyRegistry`；在已有 `RoomManager` 旁创建唯一注册表；解析消息并取得 `now` 后调用 `lobby.handle(conn, m, now, initialLevel)`，返回 `true` 即停止路由；删除原 `create`/`join` 分支以防重复建房和绕过准入。`initialLevel` 仍沿用开发环境 `--l4-preview` 的 `L4_INDEX`，正常为 `0`。 |
| `game/shared/protocol.ts` | 导入 `parseLobbyMsg`、`sanitizePlayerName`、`LobbyClientMsg`、`LobbySettings`、`RoomsMsg`；`ClientMsg` 加 `LobbyClientMsg` 并移除旧的单独 `create` 类型；`ServerMsg` 加 `RoomsMsg`，原 `room` 消息类型交叉 `Partial<LobbySettings>`；`hello` 的原昵称清理替换为 `sanitizePlayerName`；`list`/`quick`/`create` 三种解析委托给 `parseLobbyMsg`。 |
| `game/server/room.ts` | 类型导入 `LobbySettings`，在 `Room` 中新增可选 `lobbySettings`；`broadcastRoom()` 展开该设置，保证所有成员获得一致的公开/中途加入策略；`RoomManager.step(now)` 空房删除条件改为 `now - room.emptySince >= 60_000`。 |

现有重连消息和恢复连接流程继续由重连层处理，不交给大厅注册表。若 `hello` 带恢复字段，保留目标分支的字段校验与恢复逻辑，只合入昵称清理这一小处。注册表的 `handle()` 仅消费 `list`、`create`、`quick`、`join`，其余返回 `false`，仍进入既有路由。

`game/client/src/main.ts` 也必须按最小 hunk 接线：将 `PublicLobby` 的 `welcome`、`onMessage` 和 `disconnect` 钩子接在目标分支恢复消息处理的正确位置，保留原有恢复身份、恢复房间与自动重连状态转换。大厅消息消费不能提前截断恢复消息分支；本 lane 的旧 `onClose` 处理不能整段覆盖目标分支的瞬时断连与自动重连流程。

通用消息限流必须在大厅路由之前生效；注册表只提供每连接 `list` 至少间隔 1 秒，以及 `create`/`quick` 共用的 1 秒间隔。`join` 保持原有即时房间码加入行为，交由连接层的通用消息限流覆盖；尤其重复加入当前房间会广播成员列表。连接层的房间上限、IP 连接上限、非法消息计数与重连身份策略仍使用目标分支已有实现。

恢复原玩家时，应走重连层的恢复路径；普通新加入必须走注册表，随后由 `Room.add()` 以观察者身份进入已开始的房间。不要把恢复已有玩家等同于新的 `join`，否则会改变原位置或玩家状态。最后一位玩家断开时何时调用 `Room.remove()`，由重连层的断线保留期限决定；大厅的 60 秒回收从房间实际变空的 `emptySince` 开始计算。

## 已核对的行为

- 旧客户端省略 `public` 时创建私密房；私密房不出现在任何列表响应中，仍可凭房间码加入。
- 只有非空、未通关的公开房进入列表；等待房排在进行中房前，同状态人数多的在前，人数相同时按房间码排序。满房继续展示，但不可加入。
- `quick` 只选择未满的等待公开房，并优先人数最多者；没有候选才创建公开等待房。当前房间也参加选择：若它是排序最前的候选则保持原房并广播名单，若其它候选排在前面则正常切换（人数相同也按房间码排序）。UI 进入房间后不再提供快速加入按钮。
- 进行中房间默认允许新玩家作为观察者加入；`allowLateJoin: false` 同时禁止列表按钮与房间码加入，公开和私密房均适用。加入者在下一次换关或本关全灭重开后恢复为可玩状态。
- 失败的加入检查发生在退出旧房间之前；错码、满房、已关闭或通关、禁止中途加入均保留玩家原房。重复加入当前房间不重建玩家、不转为观察者。
- 空房立即从发现和匹配中排除，房间码也禁止普通新加入；对象保留至最后一位玩家离开后满 60 秒，由 `RoomManager.step(now)` 回收。观察者仍占 `n/4` 的一个名额。
- `level` 在线路上为从 `0` 开始的关卡索引，UI 显示时加 `1`；列表往返时间是当前连接到同一大厅服务器的 RTT。

## 验证入口

`game/tests/unit/lobby_registry.test.ts` 覆盖公开/私密、排序匹配、准入、空房回收和限频；`game/tests/unit/room_lobby.test.ts` 覆盖房主开始、房主转移，以及观察者不阻塞通关且在下一关恢复可玩。`game/tests/e2e/public-lobby.spec.ts` 使用三个独立浏览器上下文验证真实 WebSocket 大厅流程。

并行冲刺中，只有 typecheck、Vitest 和 build 使用 `python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- <command>`，Vitest 需带 `--maxWorkers=1`。所有浏览器与 Playwright 验证使用 `python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- <command>`，固定端口 `4431`，使用 Metal、headless，并启用 `mute-audio`。

公共大厅与重连最终合并后，由集成代理串行运行合并结果的协议、注册表和房间大厅测试及完整项目闸门；本 lane 禁止直接运行全量 `check`。部署与公网 `4100` 复验也由集成代理负责，本 lane 不自行部署。单个工作树的结果不能替代合并验证。

## 2026-11-05 20:00 恢复后本树验证记录

| 验证 | 实际结果 |
| --- | --- |
| TypeScript `tsc` | 本轮经 heavy 闸门重新通过；触屏用例修改后再次通过。 |
| `gate heavy` 定向 Vitest | 注册表、房间大厅、客户端共 3 文件、37/37 通过，含容量拒绝保留原房回归。命令：`npx vitest run tests/unit/lobby_registry.test.ts tests/unit/lobby_client.test.ts tests/unit/room_lobby.test.ts --maxWorkers=1`。 |
| `npm run build` | 本轮经 heavy 闸门重新通过；导航图 4069 个节点、0 failures。触屏样式修改后 `npm run build:client` 再次通过。 |
| 三真实 WebSocket 客户端 | 本轮在新构建、本树独占的 `4431` 服务器重跑 6/6 通过，`maxConcurrentPeers: 3`，2916 ms。报告：`game/test-results/public-lobby-ws.json`。 |
| 证据脱敏 | 对本轮实际 WebSocket 报告递归检查通过，未含凭据字段；welcome 仅含 `t`/`id`。 |
| 触屏滚动诊断 | 真实 touch 事件命中房间列表；列表内容高与容器高均 165 px，`overscroll-behavior-y: contain` 把滑动截住。改为 auto 后大厅滚动 0→231 px，根节点保留原 touch-action 规则时同样通过。证据：`game/test-results/lobby-touch-diagnose.json`。 |
| 浏览器 / 三个独立上下文 | 修复后的完整用例 1/1 通过，14.6 s，0 重试；一个 Metal/headless/mute-audio 浏览器、三个独立上下文，含真实触屏滑动/点按快入、三人进入 L1、私密隐藏与按码加入、观察者准入及关闭中途加入。报告 `game/test-results/public-lobby-browser.json`：5 个场景、faults 为空。命令：`npx playwright test -c playwright.lobby.config.ts`。 |
| 截图亲自检查 | 桌面 `public-lobby-desktop.png`、手机首屏 `public-lobby-mobile-844x390.png`、手机滑动后 `public-lobby-mobile-scrolled-844x390.png` 均在 `game/test-results/`；房名/人数/状态/快入清楚，手机按码加入与原更新通知可滑动到达，无横向溢出。 |
| 测试服务回收 | WebSocket 与诊断脚本已关闭其自行启动的服务器，Playwright 已回收自己的 webServer；最终 `4431` 无监听。 |

恢复时上轮唯一未提交改动是本文档对旧验证状态的纠正，未重置或覆盖。上述 WebSocket 结果为本轮重新执行所得，不沿用旧报告。本 lane 未生成视频，也未取得外部视频评分；本 lane 无 Gemini 工具。本地结果不代表合并后全量检查或公网复验已完成；真实 50 房上限与重连最终组合仍待集成验证。

## 部署交接

集成代理先按前述最小 hunks 合并重连改动，再串行运行全量 `check`。部署后，用公共大厅 WebSocket 用例和三个独立浏览器上下文用例针对公网 `4100` 复验公开列表、快速加入、私密房与中途观察加入，并更新用户可见的版本通知。部署、公网复验和版本通知尚待集成代理执行。

## 与重连及救援工作树的只读接口核对

2026-11-05 通过 `git worktree list` 定位并只读核对 `/private/tmp/escape-sprint-reconnect`（HEAD `c829e59`）与 `/private/tmp/escape-sprint-revive_network`（HEAD `2174268`）的相关接口；此次核对未修改这些工作树。建房异常兼容修复已在本 lane 的 `30536b9` 实施，新增回归已通过统一 heavy 验证；其余为尚待在合并结果中实施和验证的建议。

- 结构类型可按现有形状合入：两树 `Conn` 仍提供 `id`、`name`、`send`、`sendRaw` 和可选 `room`；`RoomManager` 的 `rooms`、`get(code)`、`create(lobby, initialLevel)` 与注册表所需接口一致。给目标 `Room` 补入可选 `lobbySettings` 并在名单广播展开即可；重连新增的玩家离线状态不要求扩大 `LobbyRoom` 的结构类型。
- 建房上限拒绝已补兼容处理，新增回归已通过。重连树 `RoomManager.create()` 在 `rooms.size >= MAX_ROOMS`（50）时抛异常，原 `index.ts` 的建房分支负责 `try/catch`。本 lane 已只在注册表的 `directory.create()` 调用周围捕获：精确匹配已知容量错误时返回「房间数量已满，请稍后再试」，其余异常统一返回「创建房间失败，请稍后重试」，不暴露内部路径；`enter()` 与游戏逻辑不在捕获范围内。创建失败不退出原房或重置房主、玩家状态；`quick` 若已有候选仍先正常加入，只有走新建分支才调用 `create()`。新增 5 例覆盖 create/无候选 quick 的容量拒绝与原房保留、未知 Error/非 Error 的错误脱敏，以及 create 会失败时 quick 仍可加入已有候选；这些用例已随注册表 24/24 通过统一 heavy 验证，真实 50 房上限与重连最终组合仍待集成验证。
- `Room.remove(conn, now)` 的参数在两树中均未变化，注册表的切房调用可直接保留。重连树新增的连接对象身份检查必须保留，避免旧连接延迟关闭后移除替代连接；同时保留 `disconnect(conn)` 与 `resume(previous, conn, now)`，恢复时不得改走 `add()`。离线保留的玩家仍在 `players` 中，因此其名额继续计入列表 `n/4` 和 `full`；60 秒回收从保留期结束、实际移除最后一人后开始。
- 路由顺序保持为：已有关闭检查 → 通用 `guard.allow(now)` → 解析及非法消息处理 → 大厅 `handle()` → 现有 `hello`/`heartbeat`/游戏路由。注册表对 `hello` 返回 `false`，现有恢复分支、`resumePending` 分支，以及恢复成功后对 `Room.resume()` 的调用顺序应完整保留；不要把 `hello` 简化为仅设置昵称。只替换原 `create`/`join` 分支的职责。
- 救援树增加了 `act.kind: 'revive_cancel'`；保留目标协议解析和 `Room.handle()` 中在等待、倒地等状态门闸之前处理该释放消息的分支。大厅注册表对这些交互消息返回 `false`，无需改动其路由；合并 `main.ts` 时同样保留按网络节拍续发救援与释放取消的接线。

## 最终合入顺序与测试交接

以已包含重连与救援改动的集成树为基础，建议按下列顺序移植最小 hunks，再统一构建验证：

1. 先加入 `shared/lobby.ts` 并合入协议类型与解析扩展；保留目标 `hello` 的恢复字段、`welcome`/`resume` 类型和救援取消解析。
2. 给目标 `Room` 补 `lobbySettings` 与名单广播字段，将空房回收阈值改为满 60 秒；保留整个恢复/离线状态机制、连接身份检查和 `RoomManager.create()` 的 50 房上限。
3. 加入注册表并确保包含 `30536b9` 的创建异常捕获。房间公开/中途加入设置在 `Room.add()` 之前赋值，首份名单即包含正确策略。
4. 在目标 `index.ts` 现有通用限流和非法消息处理之后插入大厅路由，移除被替代的旧 `create`/`join` 分支；保留其余恢复、心跳和关闭处理。
5. 合入 UI 控件、样式和大厅控制器，再按前述恢复消息顺序接入 `main.ts` 的消息与断线钩子；不替换 `Net` 或整个 `onClose`。

`800b675` 已提交独立 Playwright 配置、浏览器大厅用例、真实 WebSocket 用例、房间大厅单测和本文档。20:00 恢复切片仅补大厅触屏滚动样式、真实触屏滑动/点按验收及实际结果记录，不修改重连共用产品文件。

集成后的测试需要保留以下边界：本树 WebSocket 脚本通过 `traceMessage` 对证据脱敏，`welcome` 仅保留 `t`/`id`，并递归过滤凭据字段；本轮已重跑真实用例且检查新报告脱敏。接入重连服务器后，集成代理仍需检查实际报告不泄露恢复字段。当前测试按本地大厅流程重建页面/连接，重连分支会保留断线玩家及其房间，浏览器上下文也可能自动恢复；集成代理需为各场景明确隔离会话或等待既有保留期结束，不能通过删除恢复机制或缩短保留期来迁就测试。WebSocket 脚本目标和独立 Playwright 配置目前固定本地 `4431`，公网复验时须由集成代理适配目标与服务启动方式，并将公网报告与本地报告区分，不能将本地结果记为公网通过。
