# 第六关考场预览验证

L6 使用教学楼 A 的四、五层真实地图：按房间 seed 抽取五道中性学校题，四层公告提供第 1–3 题线索，五层公告提供第 4–5 题线索。全队共用一张答卷；服务端只有在讲台旁收到完整正确的交卷后，才移除五层出口门禁。答错仅使交卷所在楼层熄灯十秒，并把角色074召到最近可用的门后。房间只有一个监考值日生。

本切片提供独立的 L6 开发预览。真实服务端以 `ESCAPE_TEST_LEVEL=6` 创建零起始索引为 `5` 的房间；`NODE_ENV=production` 不开放这个入口。当前主线没有合入 L5，L6 尚未注册进顺序关卡，因此这些验证不能证明从 L1 连续进入 L6，也不代表线上部署已完成。通过 L6 预览后服务端发送 `complete`；刷新后可新建房间再次挑战。

当前验证结果（2026-11-05）：最终类型检查和完整构建通过；L6 与角色074相关回归 8 个文件、77 项全部通过（包含原有 L6 的 41 项，不重复累计）；关闭门禁防绕行检查另已通过。既有输入、触屏、地图、引导及 L1–L4 回归 16 个文件、181 项全部通过。真实 WS 首轮揭示角色074生成后的首帧沿缓存导航走入关闭门边缘，已修复，最终限定只在 L6 启用的版本再次通过真实 WS 全流程，含十秒停电、六张连续快照无门碰撞、迟加入和交卷开门通关。桌面和手机浏览器实玩未完成：浏览器资源闸门等待约 21 分钟仍未启动，按本轮 10:46 UTC 截止取消了自己的排队进程。下文的截图和录像仅是脚本预定产物，本轮没有生成，不能据此声称 UI、实机光照、触控穿门或浏览器通关已通过。最终日志为 `game/test-results/l6-warden-safety-final.log`、`l6-exit-strip-validation.log`、`l6-regressions.log`、`l6-typecheck-build-final.log`、`l6-real-ws-verified-final.log`；首轮红快照保存在 `l6-warden-first-snapshot-failure.json`。

协议使用 `t: 'exam'`：客户端选择题发送 `{op:'answer', question, choice, revision}`，交卷发送 `{op:'submit', revision}`；题号限 0–4、选项限 0–3，revision 为非负安全整数。服务端发送整张共享答卷的 `answers`、`passed`、`revision`、`cooldown`、`feedback`，惩罚期间另带 `blackout:{floor,seconds}`（楼层从 0 起算，3 即四楼）。服务端拒绝旧 revision 并只向该发送者重同步；同选项重试获得确认但不增加 revision。答卷操作还须满足正常存活、未躲藏、讲台距离与无遮挡条件；倒地、旁观、过墙和远程请求均不能改卷或交卷。未答完不会触发惩罚，通过后答卷不可修改，迟加入收到完整当前状态。冷却由服务器 tick 计十秒，结束主动发送新 revision 并清除停电；团灭重置清卷、关门并保留 revision 单调递增。

`game/shared/level.ts` 中的默认 `LEVELS` 当前只含 L1–L4，`L6_INDEX=5` 只提供独立寻址，不占用缺失的 L5。未来合入 L5/L6/L7 时应按真实零基索引依次注册 `LEVELS[4]`、`LEVELS[5]`、`LEVELS[6]`；L6 不得永久硬编码为终章。房间完成条件检查下一关是否已注册，现有单测已验证注册后续关卡后能够从 L6 正常推进。

L6 的角色074沿缓存导航移动时，每个实际步长仍通过完整胶囊碰撞校验；关闭的门阻止它继续前进，真实开门后可继续追逐。该路径校验由显式 `WardenEnv.checkRouteSteps` 只对考试关启用。答错召唤不额外强制播放发现台词，因此正常六秒台词冷却仍生效，同一次失败只发一条失败台词。

本切片改动文件：

- 客户端：`game/client/src/{exam.ts,exam.css,game.ts,main.ts,input.ts,touch.ts,guide.ts,map.ts,objective.ts}`，以及 `campus/{scene.ts,render/interior_light.ts}`。
- 服务端：`game/server/{index.ts,room.ts,ai/warden.ts}`。
- 共享规则：`game/shared/{exam.ts,interact.ts,level.ts,protocol.ts,levels/def.ts,levels/l6.ts}`。
- 测试：`game/playwright.l6.config.ts`、`game/tests/{l6-real-server.mjs,l6-server-native.test.mjs,e2e-l6/exam.spec.ts}`、`game/tests/unit/{exam.test.ts,exam_room.test.ts,level6.test.ts}`。
- 交接文档：`docs/level6.md`。测试产物只保留在本树 `game/test-results/`，不提交生成的构建、截图或录像。

测试使用本树完整构建的 `dist-server/index.js` 和真实 WebSocket，没有替换 WebSocket 或伪造服务端答卷。`tests/l6-real-server.mjs` 独占 `127.0.0.1:4412`，遇到已有 TCP 监听会停止测试，并只结束自身创建的 PID。生命周期、退出状态和日志保存在 `game/test-results/l6-server-*.json`、`.log`。

在 `game/` 执行：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run tests/unit/exam.test.ts tests/unit/exam_room.test.ts tests/unit/level6.test.ts --maxWorkers=1
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
node --test tests/l6-server-native.test.mjs
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test --config playwright.l6.config.ts
```

181 项基线回归的实际命令（同在 `game/`）：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run tests/unit/input.test.ts tests/unit/input_touch.test.ts tests/unit/map.test.ts tests/unit/objective.test.ts tests/unit/guide.test.ts tests/unit/guide_campus.test.ts tests/unit/level.test.ts tests/unit/level2.test.ts tests/unit/level3.test.ts tests/unit/room_levels.test.ts tests/unit/room_loop.test.ts tests/unit/l4.test.ts tests/unit/l4_map.test.ts tests/unit/l4_movement.test.ts tests/unit/l4_nav_regressions.test.ts tests/unit/l4_ai_regressions.test.ts --maxWorkers=1 > test-results/l6-regressions.log 2>&1
```

真实 WS 测试已覆盖共享 seed、五题答卷、远程/过墙/伪造通过拒绝、过期 revision、明确交卷、十秒停电且重发不延长、最近门后角色074、单监考、迟加入旁观者、封闭实体门拒绝输入及通过后接受穿门、存活队员集合和终点状态不可改写。最终实测停电 `10146.301625 ms`，连续六张角色074快照均未碰关闭门；门关闭时从 `x=-56.85` 预测到 `x=-58.35` 被服务端拒绝，交卷通过后同段输入被接受。最终运行日志为 `game/test-results/l6-real-ws-verified-final.log`（1 项通过，15.47 秒），完整证据为 `l6-real-websocket.json`，角色074首张真实快照为 `l6-warden-first-snapshot.json`。`l6-server-websocket.json` 记录自有 PID 86858 已于 `2026-11-05T10:23:48.847Z` 收到 SIGTERM 结束，验证后 4412 没有遗留监听。

首轮 `l6-real-ws.log` 与 `l6-real-ws-retry.log` 均是修复前的失败记录，不是成功证据：门 67 中心 `x=-56.95`，角色074首帧 `x=-56.68`，胶囊侵入关闭的门边缘。原始红快照为 `l6-warden-first-snapshot-failure.json`；修复后首帧为 `x=-56.45`，通过原有门后位置断言，并新增完整胶囊无碰撞和门后视线遮挡断言。

最终源码实际执行的构建与 WS 命令：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- sh -c 'npm run typecheck && npm run build' > test-results/l6-typecheck-build-final.log 2>&1
node --test tests/l6-server-native.test.mjs > test-results/l6-real-ws-verified-final.log 2>&1
```

浏览器脚本配置为只启动一个 Chromium 进程，使用 ANGLE Metal 和 `--mute-audio`。计划依次执行桌面 1280×720 与手机横屏 844×390 操作，另检查手机竖屏答卷。建房、加入、公告/试卷点击与 E/触屏互动、作答、交卷、移动及门禁穿越使用真实浏览器输入；位置初始化、瞄准、单监考展示和怪物保护使用明确的开发 debug 指令。楼梯另外通过原有自动路径实际行走验证，不把传送当成楼梯通行证据。

普通断言阶段设计为使用 `?nodraw&steady` 维持确定性，截图主动渲染真实场景；脚本另安排桌面和手机分别约十五秒连续渲染、真实输入移动和手电操作录像。预定浏览器证据为 `game/test-results/l6-browser-evidence.json`，截图为 `game/test-results/l6-*.png`，录像为 `game/test-results/l6-playwright/` 与 `l6-video/` 内的 WebM；本轮均未生成，因此没有截图可亲自检查，也没有录像或外部模型评分。

实际浏览器命令为 `python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test --config playwright.l6.config.ts > test-results/l6-browser-final.log 2>&1`。自有排队 PID 90083 在 10:46 UTC 仍没有 Playwright 子进程，资源锁由其他活跃的浏览器/集成任务占用；只取消该 PID 后退出码为 143，未碰其他 PID 或资源锁。`l6-browser-final.log` 为空，队列阻塞记录为 `l6-browser-queue-blocked.json`。收尾再次确认 PID 90083、最后一次自有服务 PID 86858 均不存在，4412 没有监听。后续集成需要先按上述命令完成真实桌面与手机实玩，并亲自检查实际生成的截图；目前不能把本切片称为浏览器实玩通过或已上线。
