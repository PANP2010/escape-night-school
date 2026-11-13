# L1/L2 目标与人数难度验证

验证范围：L1 抽屉钥匙 → 上锁讲台抽屉/楼梯钥匙 → 全员集合；真假钥匙识别；L1 后半及 L2 值日生人数缩放；同 seed 团灭重开；三人救援。没有修改角色074 AI、模型、动画或导演。

## 当前参数

| 项目 | 参数/规则 |
| --- | --- |
| L1/L2 值日生 | 1 人局 1 个，2–4 人局 2 个 |
| L1 激活门槛 | 拿到真抽屉钥匙后才允许生成；假钥匙不触发 |
| 安全生成 | 距每个出生点、当前非观战玩家至少 20 m，彼此至少 4 m；无安全点就延后重试 |
| 新生成值日生 | 保留原 AI 的 15 s 等待；开场全局保护仍为 15 s |
| 救援 | 值日生碰撞每 tick 最多放倒 1 人；抱团队友有 3.5 s 救援窗口；按住 3 s 救起，获救后保护 5 s |
| 人数采样 | 关卡开局锁定人数，同关重开保留；旁观者不增加难度 |
| L1/L2 电池 | 每名开局玩家有 1 个替换电池；起始电量加补给共 360 s 常亮，或 240 s 跑步常亮 |

## 验证方式与样本局限

- 单元回归保留原有距离、道具唯一拾取、出生保护、救援及关卡切换断言；升级旧两步目标断言，并新增 L1 seed 1/4/7、1–4 人真实校园导航上的安全生成/可达/重开检查，以及 L1/L2 人数、电池与救援缩放检查。
- `tests/probe-level-difficulty.ts` 使用单人真实 Room、校园碰撞、门与怪物，按 20 TPS 快进。输出的秒数是模拟游戏时间，**不是浏览器实时时间或真人游戏时间**。原始基准知道所有真物品位置；后续策略按正式 8 m 视距、LOS 和 4 Hz 更新发现物品。所有策略仍知道地图、目标类型与 AI 状态，瞬时准确转头并优先盯住值日生，只验证理想路线可行性；没有多人自然通关样本。
- 浏览器功能回归用 `debug safe` 隔离怪物、`debug tp` 到交互物旁，实际键盘 E 或手机直接点物品拾取；没有用 `debug key` 跳过抽屉锁。这些截图与三步流程不计作自然通关或威胁样本。
- 独立威胁样本保留真实 AI、无 debug safe/召唤。L1 为隔离后半段触发，把测试玩家放到真抽屉钥匙旁后经 `Room.act` 拾取；这不是自然探索路线。L2 从自然出生点开始。
- 没有真人初见样本，也没有外部视频评分，不能据此宣称首次通关中位数达到 6–10 分钟或平均被抓 ≥1 次。
- 电池秒数是现有耗电常量推算的预算。路线脚本没有开启手电，也没有实测电量耗尽；不能把路线耗时当作真实照明预算验证。

## 实际结果

全量单元回归 **84 文件、712 项通过**（59.96 s）。此后对“同 attempt 的房间人数更新不撤过场”做了最后一处 `loadLevel`/`main` 修复；最终代码再次通过类型检查、`client_loop` + `transitions` **2 文件、12 项**针对回归，以及客户端、服务端和导航构建。最终导航 4069 节点、0 failures；没有在这处过场修复后重复全量 712 项。`git diff --check` 通过。

首次自然 AI 路线采样如下。连续奔跑、瞬时看向可见值日生，240 模拟秒上限；所有样本服务器拒绝移动次数为 0。“被发现”计入角色074/值日生进入 chase 的上升沿，不能等同真人感知或独立遭遇。

| Seed | 关卡 | 模拟秒 | 结果 | 被发现 | 被抓 |
| --- | --- | ---: | --- | ---: | ---: |
| 1 | L1 | 28.90 | 通关 | 2 | 0 |
| 4 | L1 | 22.80 | 通关 | 1 | 0 |
| 7 | L1 | 240.00 | 路线停滞，达到上限 | 12 | 0 |
| 1 | L2 | 80.05 | 被抓 | 3 | 1 |
| 4 | L2 | 20.10 | 被抓 | 2 | 1 |
| 7 | L2 | 100.15 | 被抓 | 3 | 1 |

独立威胁样本 seed 4：L1 真钥匙旁放置后，14.95 s 首次 chase、51.25 s 被抓；L2 自然出生，14.95 s 首次 chase、19.85 s 被抓。这证明真实威胁能生效；没有满足“真人平均被抓”指标的统计含义。

补充采样采用正式物品发现范围、4 Hz 导引更新、XYZ 拒绝检测，每个关卡从自然出生点独立开始。以下均为模拟秒；“warden/值”表示被对应敌人抓到，未通关。

| 策略 | L1 seed 1 / 4 / 7 | L2 seed 1 / 4 / 7 |
| --- | --- | --- |
| quiet-guide：平时走路、被追时跑 | 通 41.10 / 通 33.60 / 通 33.20 | warden 21.15 / 值 16.20 / warden 16.60 |
| adaptive-guide：近warden蹲行、被追时跑 | warden 26.30 / warden 15.65 / 通 33.75 | warden 22.90 / 值 20.10 / warden 16.70 |
| run-guide：持续跑、准确凝视 | 未采样 | warden 15.60 / **通 20.40** / warden 15.55 |

新增 15 条路线共 5 条通关，L2 为 **1/9**；所有新增样本 XYZ/Y 移动拒绝均为 0。L2 seed 4 正常拾取并插入 3 枚保险丝后通关，15.00 s 起角色074和值日生都进入追逐，未使用 debug、没有被抓。已取得 L1/L2 各至少一条真实 AI 自然通关，**不能据此宣称平衡稳定或新手难度达标**。

原始 L1 seed 7 终点 `[-57.3501, 0, 81.4501]` 已有两把真钥匙，处于集合阶段；导引点 `[-56.25, 0, 78.35]` 跨墙角，160–235 s 位置不变。真实 4 Hz quiet 路线同 seed 能通关，说明不是目标锁死；局部墙角路线跟随仍有剩余风险，不能宣称所有箭头角落都无停滞。

最终构建的浏览器专项 **1 项通过，50.7 s**，一个浏览器顺序执行 1280×720 桌面与 844×390 手机：

- 真钥匙 → 上锁讲台抽屉 → 全员集合三步、未持钥匙拒绝开抽屉、假钥匙拒绝拾取，均通过实际键盘 E / 手机直接点物品完成。
- 团灭过场中旁观者离开，房间人数更新为 1 人后等待 250 ms 旧快照；过场仍可见且 `body.level-handoff` 保留，同 attempt 没有清掉旧探索。新 attempt +1 后，同 seed 下背包、两把真钥匙、探索标记、地图与教程均重置。
- 三个真实 WebSocket 客户端均同步看到救援成功，实际连续互动 **3053 ms**；之后 **2100 ms** 三端持续存活。页面运行错误 `[]`。
- 10 张桌面/手机三步、锁住抽屉及重开截图已亲看；最终截图重新核对真钥匙截图无残留假钥匙 toast，手机阶段 2/3 的真假线索、看停及救援长说明完整可读，不遮地图/聊天或右下按钮。抽屉主体在环境光下偏暗，顶部标牌与交互提示可读。

Playwright 已退出 0，4454 端口没有残留 listener，本 lane 无后台检查/测试服务器。证据目录为 `game/test-results/level-difficulty/`，功能结果在 `functional-results.json`，截图为 `desktop-*` / `phone-*.png`；基准、补充矩阵、run-guide 与基准端点诊断分别保留为 `path-samples-baseline.json`、`path-samples-quiet-guide+adaptive-guide.json`、`path-samples-run-guide.json`、`path-samples-baseline-diagnostics.json`。

## 可复跑命令

在 `game/` 执行，所有重任务均走共享资源闸门：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run --maxWorkers=1
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run tests/unit/client_loop.test.ts tests/unit/transitions.test.ts --maxWorkers=1
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- sh -c 'npx vite build --config vite.server.config.ts --ssr tests/probe-level-difficulty.ts --outDir test-results/level-difficulty-probe && node test-results/level-difficulty-probe/index.js'
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- env PROBE_STRATEGIES=run-guide PROBE_LEVELS=2 node test-results/level-difficulty-probe/index.js
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- env PROBE_STRATEGIES=baseline-run node test-results/level-difficulty-probe/index.js
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c playwright.level-difficulty.config.ts
```

独立 Playwright 配置只用端口 4454，一个 headless Chromium 浏览器、ANGLE Metal 与 `--mute-audio`；桌面/手机 context 顺序运行，测试服务器由 Playwright 启动并在结束时关闭。

路线脚本依赖项目里由 Vite 处理的 JSON import，先按上述命令 SSR 打包，再用 Node 执行；直接 `node tests/probe-level-difficulty.ts` 在当前 Node 26 会因现有 JSON import attribute 缺失失败。打包输出位于 `test-results`，不纳入提交。

## 改动文件分组

- 共享规则共 7 个：`game/shared/{difficulty,l1Objectives,level,protocol}.ts`、`game/shared/levels/{def,l1,l2}.ts`。
- 服务端：`game/server/room.ts`，负责权威锁定/拾取、人数缩放、安全生成、救援和重开 attempt。
- 客户端：`game/client/src/{game,guide,hudText,main,objective}.ts`，负责三步目标、真假钥匙/抽屉呈现和交互、导引、重置及过场。
- 新单元测试：`difficulty_campus.test.ts`、`l1_objectives.test.ts`、`room_difficulty.test.ts`；适配既有 `client_loop`、`debug_msg`、`guide`、`guide_campus`、`level`、`level2`、`monitor`、`objective`、`room_campus`，均在 `game/tests/unit/`。
- 浏览器与采样：新增 `game/tests/e2e/x-level-difficulty.spec.ts`、`game/playwright.level-difficulty.config.ts`、`game/tests/probe-level-difficulty.ts`；适配 `game/tests/e2e/x-multi.spec.ts`、`game/tests/e2e-pending/x-guide.spec.ts`。
- 本验证文档；`test-results`、构建产物、导航缓存及本地 `node_modules` 均不纳入提交。

## 集成事项

本 lane 保留现有通知代码，不独占全局 release 版本。统一 `release/version.json` 时建议加入用户可见条目：“第一关新增上锁讲台抽屉与真假钥匙，多人局增加值日生”。部署由集成代理负责，本树没有部署。
