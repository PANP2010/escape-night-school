# L7 镜廊 campaign 接入交接

本切片把已验镜廊机制接入主 campaign，验证记录见下文。**本 lane 不部署，部署与后续顺序集成由集成负责人完成。** 下列验证只记录真实执行结果，待验证项保留占位。

发布元数据沿用已 review 基线，本 lane 未改版本号，并保留现有更新通知功能。集成发布时需统一更新发布版本并验收用户可见更新通知；本交接不宣称用户已收到此次更新。

## 变更路径

| 范围 | 路径与职责 |
| --- | --- |
| 主服务端 | `game/server/index.ts`：开发环境 `--l7-preview`；`game/server/room.ts`：章节装载、碰撞、交互、快照与既有生存流程接线 |
| 镜廊服务端 | `game/server/l7-campaign.ts`：团队镜钥与密门；`game/server/l7-key.ts`：值日生转身时钟；`game/server/ai/mirror.ts`：每位玩家独立的延迟倒影与追击 |
| 共享协议与规则 | `game/shared/l7-campaign.ts`、`game/shared/l7-key.ts`、`game/shared/protocol.ts`、`game/shared/interact.ts` |
| 关卡注册与几何 | `game/shared/levels/l7.ts`、`game/shared/levels/def.ts`、`game/shared/level.ts` |
| 主客户端 | `game/client/src/game.ts`、`game/client/src/main.ts`、`game/client/src/transitions.ts`：既有 Game、Net、切关、罚站与完成提示接线 |
| 镜面表现与引导 | `game/client/src/l7-view.ts`、`game/client/src/campaignMirror.ts`、`game/client/src/objective.ts`、`game/client/src/hudText.ts` |
| 镜廊单测 | `game/tests/unit/l7_campaign_protocol.test.ts`、`l7_campaign_room.test.ts`、`l7_key.test.ts`、`level7.test.ts`、`mirror_ai.test.ts`（均在同目录） |
| 客户端接线回归 | `game/tests/unit/l7_campaign_client.test.ts`：共享发现、引导、触屏和门碰撞；`game/tests/unit/client_loop.test.ts`：既有主 Game 夹具随新增字段补齐 |
| 定向真实链路验证 | `game/playwright.l7-campaign.config.ts`、`game/tests/e2e-l7-campaign/campaign.spec.ts`、`game/tests/e2e-l7-campaign/desktop.spec.ts` |

`game/node_modules` 是共享依赖链接，不属于交付源码，不安装或修改其中依赖。原有未提交工作全部保留。

## 协议与同房集成

- 唯一游戏 WebSocket 为主 `/ws`。没有新增 `l7.html`、`/ws/l7` 或 `L7Room`。
- 镜廊沿用原连接、房间码、房主、玩家 id、slot、seed、队伍名单和主 Game；`room.level = 6` 表示第七关。
- 交互走普通消息：`{t:'act', kind:'mirror-key', id:0}` 与 `{t:'act', kind:'mirror-push', id:1|2}`。取钥和推墙只读取该连接在 Room 内的位置、朝向和状态；协议剥离客户端附带的 pose、钥匙状态或身份字段。
- 服务端补充 `{t:'l7', tick, mirrors, revealedDoors, openDoors, key}`。`mirrors` 按原玩家 id 标识倒影；`revealedDoors` 是排序后的全队已发现密门编号，交互提示与引导据此出现，避免提前泄露秘密墙位置。镜钥独立于普通背包，普通楼梯钥匙不能替代它。晚加入者收到完整状态并沿用观察者规则。
- 主 Room 校验移动、区域、楼层、墙体、家具、普通门与密门。推墙更新真实几何及导航；普通 LAB 门仍走既有 `doors` / `act use` 与权威碰撞。
- 镜中人抓捕转入原 `caught by:'mirror'`、30 秒罚站、持续 3 秒救援、超时观察者和全员出局重开。换关保留队伍身份并复活观察者；L7 出口等待全部非观察者恢复并集合。

## 保留的镜廊机制

镜钥只可通过镜中所见的值日生背后空档取得。直接盯着真人会冻结其转身；镜中观察不冻结转身。取钥校验镜面、背包对应点、距离、朝向、楼层及两段真实视线，错层或隔墙请求无效。每层密门须先在对应镜子中被发现；二层密门另需镜钥，发现与钥匙归全队共享。

倒影保留 0.6 秒姿态延迟。倒影停止后完整等待 5 秒，再从镜面出现追击完整 4 秒，包含跨 tick 的部分时长；时长未缩短。每位玩家独立计时与追逐。背向、失去镜面视线、离开镜廊、倒地或离线沿用已验版本的取消规则。追击使用主服务端胶囊碰撞与视线，不能隔薄墙抓人。

新增镜面组件没有系统中文朗读入口，沿用主 Game 的 Sound、触觉、倒地罚站和 Transitions 过场。既有 Voice、角色074表现、声音资源与更新通知实现未被替换；L1–L4 的原提示与完成文案继续保留。

## 章节接口与当前边界

生产关卡表继续只有真实 L1–L4；`levelDefinition(6)` 定向注册真实 L7。**没有生产 L5、L6、L8 占位定义。** 开发调试可通过主 `/ws` 的 `debug level:6` 或开发服务器 `--l7-preview` 进入 L7；后者仍先进入主房间大厅、由房主开始。生产环境忽略定向调试，创建房间也不会启用 preview 参数。

换关仍检查 `hasLevel(current + 1)`：后续集成负责人注册真实 L5/L6/L8 后，L6→L7→L8 自动沿主 Room 的顺序装载，不重建连接或队伍。单测临时以已有完整校园定义作为 L6/L8 接口夹具，验证这个机械交接；这不代表两关内容已经实现或顺序集成已经完成。

目前 L7 后尚无真实 L8，因此 L7 集合、黑屏 3 秒后沿用基线 `complete {level:6}` 语义，客户端显示镜廊挑战完成。这是现有可用章节结束，不能宣称八关主线已通关。L4 后的基线完成行为同样保留。

## 审查与新增覆盖

本轮服务端补完了合并碰撞世界时复制地面洞数据，以及先解析目标关卡、成功后才改变 Room 状态，避免无效注册索引留下半切关状态。

恢复后再修补共用 `toggleDoor` 的楼层校验：旧式 `door` 消息也必须与门在同层，避免一楼玩家操作同坐标的二楼 LAB 门；新增双向错层拒绝与同层正常开关回归。L7 的倒影停住、出镜预警改写到常驻目标面板，取钥和推墙沿用已有目标进阶横幅，减少手机画面中重叠的字幕；追击、拾取、推墙声音和触觉保留，通用被抓与罚站过场未改。

新增与补强的 Room 测试包括：

- 测试夹具 L6→真实 L7→测试夹具 L8；保留 Room、连接、玩家对象、id、slot、房主和 seed，重置 bag / teamKeys，复活观察者，离开 L7 时清除镜廊状态。
- 网络 `act use` 关上真实 LAB 门后，正常 `input` 穿门被拒；打开后可穿过，且此前推开的密门保持状态。
- 伪造交互附带的位置、朝向、taken/open 或他人身份不会授权取钥；远距、错层、面朝真人、实际碰撞体遮挡、坏 id 与倒地请求均拒绝，移走遮挡后合法操作可取钥。
- 黑屏换关与完成期间，网络或直接交互均被挡在谜题逻辑外，镜廊时钟停止。
- 一人观镜后，已发现密门同步给全队和晚加入观察者，未观镜队友也能推已发现的墙；发现者离线不清掉团队发现，全员出局重开则清空。快照发现编号排序稳定且不暴露服务器内部 Set 的可变引用。

既有新增单测另覆盖协议形状、真实 LAB 镜面两段视线、共享钥匙与转身窗口、密门碰撞与导航、晚加入观察者、实际镜中人抓捕与持续救援、重开复位、离线清理，以及 0.6 秒延迟 / 5 秒等待 / 4 秒追击的部分 tick 边界。

## 验证记录与限制

| 验证 | 结果 |
| --- | --- |
| TypeScript | 最新完整源码（含最终两份 e2e）经 `gate heavy -- npm run typecheck` 真实复跑退出 0；交付日志 `game/test-results/l7-client-review-typecheck-delivery.log` |
| L7 定向单测与接线回归 | 最终 `gate heavy` 定向回归 21 文件、259 项全部通过，含镜钥/镜中人、L6/L7/L8 夹具、主 Room、门和客户端接线；3.55 秒，日志 `game/test-results/l7-client-review-vitest-final.log`。此前 174 项与恢复后 145 项通过记录仍保留 |
| 完整单测 | 首轮 776/777 通过，唯一失败为 `L7 in the campaign Room > hands off L6 → L7 → L8 through test-only campus fixtures, preserving the room and reviving observers`。测试把真实 L1 楼梯出口误设成 y=0，已改为当前世界 `groundHeight`；产品出口与严格位置断言未改。修复后，失败项及相邻接线回归 174 项已通过；本 lane 未重跑完整集，最终全量由集成代理串行执行 |
| Client / Server 构建 | 最终 `gate heavy -- npm run build` 退出 0：client 128 modules、server 93 modules；导航 4069 点、0 fail；日志 `game/test-results/l7-client-review-build-final.log` |
| 主 `/ws` 手机定向验证 | 最终与桌面共用一次 Metal、静音 headless 会话串行执行，`gate browser` 2 passed / 55.5 秒。844×390 手机 + 三名普通 `/ws` 队友；开发指令只布置 L7 入口与安全状态，钥匙和两道墙用真实屏幕点按、楼梯和出口走正常 input 校验；唯一主 `/ws` 连接、身份/房间保持。验证晚加入观察者、全队发现/钥匙/密门同步、集合完成、无非强制 correct、无 console/pageerror。Apple M4，52 draw calls / 28612 triangles，镜面 1、render target 0；still/chase 实时 DOM 证明目标提示正确且无重复中央预警。日志 `game/test-results/l7-campaign-final-acceptance.log`；最终 JSON 和截图在 `game/test-results/l7-campaign-final-acceptance/` |
| 桌面键盘、救援与普通门 | 1280×720 真客户端 + 普通 `/ws` 队友，同一最终验收会话。键盘 E 取镜钥/推墙；真实长按 E 救援 3015 ms、tick 263→323 满 60 tick，救起后 44 样本、43 tick、2185 ms 均双方 ST_OK。截图等倒地/起身过渡完成，能见完整趴地及站起。普通 LAB 门 154 关闭挡在 z=141.6501，打开后键盘穿至 z=140.51688，队友权威位置一致，原镜钥/密门状态保留；无非强制 correct、无 console/pageerror。12 张最终截图已由验收代理全部查看，主代理另亲自查看关键镜钥、二层镜、倒地/复活与普通门截图 |
| 四人带宽 | 真实 Room 纯模拟：背离镜面 8.013 KiB/s/人，持续观镜 17.149 KiB/s/人，后者超预算；见下文测量方法与日志 |
| 多浏览器与音视频外部评分 | 未执行；普通 `/ws` 队友没有第二个渲染客户端，当前无 Gemini 工具，未做外部评分 |
| 提交 | 见 git 提交记录 |
| 部署 | 未部署；由集成负责人处理 |

所有 typecheck、vitest、build 需通过 `python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- <command>`；vitest 使用 `--maxWorkers=1`，由负责人统一串行执行。Playwright 另用 `gate browser`，定向配置为 `game/playwright.l7-campaign.config.ts`。静态审查未自行开启浏览器或服务。

前一轮定向 174 项与 typecheck 已实际通过，但日志被 Playwright 默认输出目录清理；上表采用之后真实复跑并保留下来的日志，未重建旧日志内容。

恢复时定位到浏览器用例尚未执行的原因：L7 直接导入碰撞 JSON 缺少原生 Node 要求的 `with { type: 'json' }`，现已补上。随后手机流程的第一次推墙点按落在可见的取钥字幕上，被既有 HUD 防穿透规则正确拦截；测试改为等字幕和目标横幅收起后点原墙面坐标，未放宽碰撞、取钥、安全或通关断言。失败日志及诊断证据保留在 `game/test-results/l7-campaign-e2e-recovery*.log` 与两个 failure 目录。

前轮两位只读子代理复核 Room/协议与 Game/镜面清理，未确认新增阻断缺陷。当前无 Gemini 工具，视频与音效未做外部评分；浏览器始终使用 Metal、headless、mute-audio。

本次恢复另经服务端与客户端代理独立复核，修补上述旧式开门错层缺口后，最终定向回归 21 文件、259 项通过，类型检查与构建退出 0。相应日志为 `game/test-results/l7-client-review-{typecheck,vitest,build}-final.log`。桌面首轮已实际走到普通门操作，测试漏记后续快照中省略的增量门态而失败；现改为累计收到的门态并保留严格开关断言，首轮失败证据在 `game/test-results/l7-campaign-desktop-acceptance/`，最终桌面与手机复验见上表。

最终手机 `phone-mirror-chase-warning.png` 的 WebGL 出镜画面与持续更新的 HUD 横跨阶段切换，图中目标提示已回到 still，因此只证明出镜画面，不作为精确 chase 警告静帧。`campaign-evidence.json` 的 `warningChannels` 保留自己处于 still/chase 时的实时目标提示及无重复中央文字的 DOM 证据；未通过冻结产品时钟来改造画面。最终测试服务由 Playwright 自停，4441 已确认无监听。

四人带宽已用真实 Room 纯模拟测量，每场景 10 秒、200 ticks，排除加入全量，计所有连接 `send/sendRaw` 的 UTF-8 JSON 字节，不含传输层头部。背离镜面站立为每连接 8.013 KiB/s，其中 L7 占 42.56%；四人轻微转头持续观镜为 17.149 KiB/s，其中 L7 占 70.33%。四人均正常、无抓捕或位置纠正；未测最坏追逐场景。观镜场景确认超过原 8 KB/s 预算，后续需对镜廊快照做压缩或增量发送。无端口、浏览器或 debug 布置，日志及复现脚本分别为 `game/test-results/l7-campaign-bandwidth-review.log` 与同名 `.mjs`。

首轮完整测试中，既有 `static_delivery.test.ts` 曾自行启动 4385 端口的临时服务，随后已自行退出；这偏离本 lane 只用 4441 端口的约束。发现后本 lane 不再运行完整集，后续服务仅用 4441，最终全量测试由集成代理串行执行。

已知限制：L7 的完整镜廊快照按 20 Hz 广播，四人观镜的每人下行已测超预算，本轮保留机制协议。镜内 LAB 普通门采用静态几何表现，现实门仍使用主 Game 的动画和权威碰撞，镜内外门态一致性保留为表现风险。测试夹具只验证顺序接口，真实 L6/L8 内容与校园导航衔接仍须集成验证。多浏览器画面、视频与音效外部评分未完成；单页渲染与普通 `/ws` 队友的验证不能替代这些验收。
