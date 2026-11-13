# L1 安全目击交接

本切片在当前校园 L1 安排一次非攻击横穿。选择器验证角色074原位置与落点对全队不可见，路线全程距离每位玩家至少 6 m、同层、胶囊可通行，且途中有正常玩家能看见。安全否决使用水平/垂直半角 75°/50°、多个身体高度与横向采样，不按欧氏距离裁掉远处可见源；有效目击使用较窄的 50°/35°视锥、躯干中心与 20 m 距离上限。任一相机仍在加载、玩家正在被保护、出现自由观察者、已有追击/抓捕/撤退或其他控制器占用时延后。L4 广播与 L8 终章保留控制。

相机可信状态随出生、correct 和修正纪元失效；stale/legacy 输入不恢复 `cameraKnown`，只有明确 `m.c === pl.c` 的当前纪元输入恢复。横穿和离场期间若出现未知相机或自由观察者，也立即停步并保持无害，等可信视点恢复后再继续。

候选位于 A 楼西走廊，两个方向互为备选，速度 1.4 m/s。普通 1/3/4 人出生队形均在首分钟可见。60 秒是普通开局目标；没有安全机会时继续等待。展示与离场保持非攻击，离场至少保护 20 秒，并实际沿胶囊验证的路线走到全员 15 m 外、不可见的同层导航节点才交还 AI。每段离场路线重新检查与玩家的整段 6 m 净距；玩家移动后重新规划，不能仅检查步进终点。没有安全出口时保持无害，不瞬移回最近节点。

源点到落点至少 3.1 m，首帧只发布精确落点，因此两位小数快照也能触发现有客户端 `>3 m` 插值折叠；未新增协议。台词只使用 `shared/lines.ts` 的现有巡逻触发器。本切片没有新音效。

## 验证

所有命令从 `game/` 执行，经共享资源 gate，未执行全量 `npm run check`。

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run tests/unit/sighting_safe.test.ts tests/unit/sighting_room.test.ts tests/unit/spawn_grace.test.ts tests/unit/warden_spawncatch.test.ts tests/unit/warden_ai.test.ts tests/unit/warden_campus.test.ts tests/unit/mob_interp.test.ts tests/unit/room_levels.test.ts tests/unit/l4_ai_regressions.test.ts --maxWorkers=1
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c tests/playwright.sighting.config.ts
```

单测覆盖全队视锥与 LOS、可见源不得消失、躲藏/无法担当目击者的视点仍能否决瞬移、路线中段近距、墙体/跨层/导航连接、出生保护、共享 45 秒冷却、追击/抓捕/撤退、L4/L8 控制。真实 Room 以校园碰撞、关门导航、普通输入模拟 1/3/4 人各 6 个种子，共 18 场首分钟；使用真实客户端初始 yaw=π/2，手电关闭，不调用调试保护。每人独立测量 55°半角视锥、墙/门/关卡障碍 LOS、720p/75°垂直视角下保守 1.75 m 模型投影高度超过 40 px，并要求脚本阶段连续可见至少一秒。另验证首落位不提前走动、线网快照位移超过 3 m、非攻击阶段无人被抓、动态接近会停步、超过 60 秒源点仍可见时继续延后、未知相机时停步、离场整段净距，以及真实走远后实际释放 AI，避免只测试到一直无害。

改前基线 `game/test-results/safe-sighting-room-baseline.json`：三人 6 种子中 4 场首分钟完全未见，另 2 场首次 48.6 秒，且 43.25 秒已先抓到一人。首 20 秒均无人倒地。

最终类型检查通过；9 个定向单测文件、75 项全部通过；构建通过，导航 4069 节点、0 失败。18 场 Room 测量首次目击为 33.8–34.85 s，每位玩家最短连续脚本目击 1.9 s，受控阶段全队最小净距 6.205 m、最大单 tick 位移 0.07 m，60 s 内抓捕总数为 0。原始测量为 `game/test-results/safe-sighting-room.json`；命令真实输出为 `validation-typecheck.log`、`validation-unit.log`、`validation-build.log`。

专用浏览器保留一渲染页 + 两个真实 WebSocket 同伴用例，另加同一个 Metal headless 浏览器内三个独立 context，三端均通过真实大厅加入、真实按键侧移清理队友遮挡，不改相机或怪物状态、不调用 debug safe/tp。各端观测实际插值模型、实际相机、墙/门/关卡障碍遮挡与队友遮挡；要求首分钟内、投影高度 >40 px、连续可见至少 1 s，逐快照核对首 20 s 无人倒地，并核对三端相同的唯一瞬移快照。

最终浏览器 2 场通过，耗时 1.4 min，`retries: 0`；使用独立完整配置，只启动 4462 一个服务和同一个 Metal headless 静音浏览器。一页 + 两个 WebSocket 同伴的首见为 41.0 s、投影 58.98 px。三真实 context 的测量如下；这次运行在各端达到至少 1 s 后结束，因此连续时长是已记录窗口而非整次横穿总时长。

| 真实客户端 | 首次脚本目击 | 已记录最长连续可见 | 首见投影高度 |
|---|---:|---:|---:|
| 甲 | 37.65 s | 1.00 s | 58.98 px |
| 乙 | 37.60 s | 1.05 s | 72.34 px |
| 丙 | 37.10 s | 1.55 s | 93.51 px |

三端各收到 397 条首 20 s 快照，无倒地状态、无 caught、无 correct，且均看到唯一相同的瞬移快照：tick 664，`[-23.56, 0, 87.55] → [-55.2, 0, 80]`。乙丙实际普通按键侧移分别为 0.454/0.850 m；相机保持真实出生朝向。三张截图已由验证代理亲自检查，远处横穿的黑外套人影在走廊端可见；主代理也已用 `view_image` 亲自检查全部四张截图，确认三实端可见横穿剪影与脚步姿态。不据此宣称近景形象或外部存在感评分达标。

验证中修正两项测试配置/路径问题，原始失败保留：`validation-browser-config-failure.log` 记录继承配置合并了额外 webServer；改为独立完整配置后只保留 4462。`validation-browser-first-attempt.log` 记录旧 WebSocket 同伴的 +1.1 m 侧移目标穿出墙体胶囊净距、持续 correct 使相机失效，另有真实客户端负向侧移被墙挡住；将普通行走动作改为墙内错开站位后通过。首 60 s、40 px、连续可见、捕获与安全断言均未放宽，产品代码未为测试绕过保护。

浏览器证据为 `safe-sighting-first-visible.png`、`safe-sighting-browser.json`、`safe-sighting-client-{1,2,3}.png`、`safe-sighting-multiplayer-browser.json` 与 `validation-browser.log`，均位于本树 `game/test-results/`。最终浏览器 spec/config 修改后再次通过类型检查。运行结束已确认 4462 无监听，自己启动的服务器 PID 82276 与 worker PID 82277 均已退出，原始清理检查为 `validation-cleanup.json`；未停止其他服务。证据不提交。

## 与其他冲刺切片合并

1. 张力导演已经有 `stepWarden()` 时保留其内容，将调用改为 `if (!this.stepSighting()) this.stepWarden()`。
2. 本切片 `Room.scareReady(now)` / `takeScare(now)` 是共享预算接缝。已有张力导演时重定向至 `this.tension.scareReady(now)` / `takeScare(now)`，删除本切片临时 `lastScare`，避免出现两份预算。跳闸与目击必须使用同一套 wrapper；关卡 reset 不清除最后惊吓时间。
3. `ctx.controlBusy` 加入张力导演的 `this.tension.resting(now)`、真实过场/抓捕镜头占用标志。保留现有出生保护、fade、未收到可信当前 epoch 相机输入及自由观察者的延后条件，以及运行中相机失效立即停步的规则。
4. 保留唯一 `directorTime()`；本切片将其定义为绝对房间秒数 `tick*TICK_MS/1000`。L1 = selector 的 `level:1`，Room 的 `levelIndex:0`，不要混用。
5. 校园区域或门布局变化后重新验证候选路径；不能用最近节点吸附替代胶囊连通检查。

## 限制

玩家分散封住所有候选、持续盯着源点/端点、存在自由观察者或没有安全离场路线时，目击可延后超过一分钟，离场也可能继续保持非攻击。静止出生队形测量不代表三次正常游玩的“每关至少三次目击”；本切片只交付一次安全开场目击与复用机制。没有录制或外部评分视频，未宣称 Gemini 存在感评分达标。本切片未移植张力导演；集成代理须将惊吓预算接到同一个 wrapper 后统一全量检查，再部署，并核对过场/张力优先级。
