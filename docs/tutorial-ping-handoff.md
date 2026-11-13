教学、触屏标记与聊天适配交接（2026-11-05，恢复分工）

工作树：`/private/tmp/escape-sprint-tutorial_ping`，分支 `codex/sprint-tutorial_ping`。保留已有提交 `8325182` 和 `4b793e2`；本次恢复追加修复与验证，没有重置 WIP。任务基线为 `2174268`，只交付本任务增量。

已实现的产品切片：

- `8325182`：L1 增加蹲行、本人拾物的渐进教学；首次真实闻香时插播闻香、关灯与躲柜提示，完成后恢复基础教学。拾物要有近期本地请求及服务器 `gone` 确认；躲藏读取本人权威快照。重开同 seed 等新出生确认后再重置。L2 显示“保险丝：包里 n · 已插 m/3”，总收集步骤仍考虑包内及已插数量。
- `4b793e2`：52px 原生“标记”按钮复用 Q，辅助说明为“标记准星位置，通知队友”；原 directtouch 继续处理门和物品。聊天有原生发送/取消按钮、中文 IME 保护、可视视口 resize/scroll 安全区及输入恢复；结算文本可滚动。
- 恢复追加：结算隐藏旧 HUD、触控和地图等界面；400×225 收起的聊天栏避开新增标记按钮；教学条位于柜缝遮罩上方，让进柜完成勾可读。补齐桌面/手机真实进柜验证，保留旋转与输入断言。

涉及文件：

- 产品：`game/client/src/{game,tutorial,objective,hudLayout,main,touch,worldTouch}.ts`、`game/client/src/style.css`。
- 单测：`game/tests/unit/{tutorial,client_tutorial,objective,hud_layout,world_touch}.test.ts`。
- 浏览器：`game/playwright.tutorial-ping.config.ts`、`game/tests/e2e/x-tutorial-ping.spec.ts`。
- 本交接文档。生成文件、共享 node_modules 链接和 test-results 均不提交。

实际验证：

- 所有 typecheck、Vitest 和 build 都通过 `python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- ...`；Vitest 为 `--maxWorkers=1`。相关 5 文件 40 项单测通过；完整 build 通过，导航 4069 节点、0 failures；最后的 CSS 修改另跑 typecheck 与 build:client 通过。
- 浏览器通过同脚本 `gate browser -- npx playwright test -c playwright.tutorial-ping.config.ts`，一个 Chromium Metal 会话、headless 与 mute-audio，独立构建服固定 4446，由 Playwright 管理退出；验证后确认 4446 无监听。
- 最终两条 E2E 通过（`2 passed (1.2m)`，重试 0），包含真实 WebSocket 的手机标记广播、摇杆、蹲、手电、点门/拾物双端确认、聊天中文组合输入不误发/不触发 Q、发送/取消/设置焦点转移后输入恢复、聊天外点击继续操作、横竖屏切换、长昵称、visualViewport 键盘与偏移模拟、400×225 罚站倒计时和结算滚动、桌面/手机真实 hide/unhide。桌面、手机和联机客户端的控制台及页面错误均为空。
- 最终聊天避让和教学层级已通过复验。400×225 下聊天右缘为 140px，标记按钮左缘为 152px；倒计时底缘为 119.5px，聊天顶缘为 177px。证据位于本树 `game/test-results/tutorial-ping/`，日志分别为 `resume-heavy.log`、`resume-final-build.log` 和 `resume-browser-verified.log`；布局及 WebSocket 记录为 `evidence/results.json`、`evidence/scent-results.json`。
- 恢复初次 E2E 在结算滚动夹具失败：原 120px 可视区能完整容纳三行文案，没有溢出；改为 80px 后实际滚动断言通过。上轮的竖屏旋转断言本轮未复现，仍保留原断言。模型 502 中断与这些产品验证记录分别说明。

集成注意与剩余边界：

- 实体 iPhone/Android 没有接入；“手机”验证为 Playwright iPhone 13 模拟（844×390、390×844，另测 400×225），键盘为 synthetic visualViewport。不能据此声称实体手机已验收。
- 结算使用展示夹具验证排版，没有在本 lane 重跑全关卡通关。没有运行全量 `npm run check`，由集成代理串行负责。
- 截图已人工查看，最终桌面/手机进柜完成勾在遮罩上方清晰可见；小屏聊天与标记按钮分离，结算文本可读且溢出时可滚动。没有可调用的 Gemini 工具，录屏未做外部评分。
- 400×225 的原有罚站标题与顶部控件仍有重叠；本任务保证倒计时、聊天与新增标记按钮分离，整体 HUD 由 mobile_hud lane 统一处理。
- 合并 `game.ts` / `objective.ts` 时保留其他 lane 的 caught 1.5s 教学隐藏、L5/L6 等关卡分支与计数；不要拿本树文件整份覆盖集成文件。地图和设置布局仍按各自 lane 的结果集成。
- 部署由集成代理负责；本 lane 不部署，不启动总循环。
