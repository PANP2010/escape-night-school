# 设置菜单交接

提交：`c66222d747f1ffe1df0a42dfa2d546506294b0a5`（设置切片 12 文件），`8184076e05d0720659a97de4f971dfcdb42d1a16`（设置 E2E 固定窗口、静音及桌面参数），`5cee227cae01d10a552a90415b120cbc1f830d12`（恢复轮设置可读性与恢复移动验收）。

12 文件：`game/client/src/{feedbackSettings.ts,fx.ts,game.ts,input.ts,main.ts,settings.css,settings.ts,touch.ts}`、`game/playwright.settings.config.ts`、`game/tests/e2e/{x-feedback.spec.ts,x-settings.spec.ts}`、`game/tests/unit/game-settings.test.ts`。保留原 WIP；未提交 dist、node_modules、.green 或 test-results。

已验证（工作目录均为 `game/`）：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node node_modules/vitest/vitest.mjs run tests/unit/input.test.ts tests/unit/input_touch.test.ts tests/unit/game-settings.test.ts tests/unit/feedback-settings.test.ts tests/unit/fx.test.ts --maxWorkers=1 --configLoader runner --no-cache --no-fsModuleCache
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- /bin/sh -c 'node node_modules/vite/bin/vite.js build --configLoader runner && node scripts/precompress.ts && node node_modules/vite/bin/vite.js build --config vite.server.config.ts --configLoader runner && node dist-server/index.js --build-nav'
```

上述均 exit 0；单测 5 文件、53 项通过；完整构建包括 client 123 modules、precompress、server 87 modules、导航 4069 nodes / 0 failures。仅有已有大 chunk 警告。新增 pointer lock probe 后又执行同一 typecheck 命令，exit 0。runner 与禁用单测缓存用于保持共享 node_modules 只读。

首轮浏览器命令：

```sh
ESC_SOFTWARE_GL=0 python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test --config=playwright.settings.config.ts
```

该轮使用 headless Metal、mute-audio，exit 1：2 passed / 1 failed（13.2s）。旧音频面板 Tab / 原生键盘操作通过；手机真实 tap 调整、DPR / 后处理、非对称安全区、关闭后触摸转向、手电、互动按钮拾取、刷新恢复偏好全部通过。桌面在初次真实 canvas click 后未获得原生 pointer lock（Expected CANVAS / Received undefined），尚未进入菜单断言，不能宣称桌面 E2E 通过。

已增加不改变 API 结果的诊断 probe（焦点、实际命中元素、输入 / fade / settings 状态、可信 click、用户激活、requestPointerLock Promise 拒绝原因与 pointerlockerror），并改为 macOS 真实窗口验证。原生 CANVAS 断言保留。窗口模式仅复跑失败桌面的命令为：

```sh
ESC_SOFTWARE_GL=0 python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test --config=playwright.settings.config.ts --grep 'desktop settings'
```

该复跑因多轮全局集成 gate 独占，一直排队，至 10:58 UTC 检查点仍无 Playwright 子进程、4433 无监听。按主代理的 70 分钟边界要求，仅终止本次 queued gate PID 12409（exit 143）；窗口模式没有启动，无结果，probe JSON 尚未生成。只读监控自行退出，未操作他人的服务或锁。

证据（均不提交，同名截图已由恢复轮更新）：

- `game/test-results/settings-mobile.png`、`settings-desktop.png`：恢复轮最终截图，均已亲自查看。手机标签不再断字，设置在非对称安全区内；内容可滚动，返回按钮始终可用。
- `game/test-results/settings-headless-initial-error.md`：首轮桌面 capture 失败记录。
- `game/test-results/settings-server-process.json`：首轮 4433 服务 PID 275 确认为本次 gate 子进程；结束后 ps exit 1、lsof exit 1。
- `game/test-results/settings-server-process-desktop.json`：窗口模式队列取消前的 PID / 无子进程 / 无 4433 监听记录。
- `game/test-results/settings-pointer-lock.json`：恢复轮原生捕获诊断，可信 click → request → resolved，最终 `locked: CANVAS`。
- `game/test-results/settings-server-process-final.json`：最终服务 PID 1664 的 `ps` exit 1、4433 `lsof` exit 1，验证结束后服务已退出。

## 恢复轮（2026-11-05，20:00 CST 后）

保留了上述三个提交和工作树现场；恢复时无未提交的产品 WIP，仅有原有 `game/node_modules` 只读软链。已通读主树 design.md、596 行 todo.md、本树交接与旧 attempt 末尾；未发现适用的 AGENTS.md。没有重放旧树或修改其他 lane。

恢复后的首轮执行同一设置浏览器命令，使用 macOS 实际窗口、ANGLE Metal、`--mute-audio`、单 worker：**3 passed（13.8 s），exit 0**。桌面原生 `document.pointerLockElement === canvas` 断言实际成立；Esc、焦点循环、关闭后恢复 pointer lock、keyup 清空、关闭后不残留移动、旧声音面板同步、同任务 close+open、刷新持久化全部通过。手机真实 tap、非对称安全区、DPR / 后处理、关闭后触摸转向 / 手电 / 互动拾取与刷新持久化通过。两张本轮截图已亲自查看，未做视频或外部评分。

随后只补设置范围的小改动：灵敏度标签缩短为「视角灵敏度」，说明保留鼠标 / 触屏含义；触屏辅助文字提高到 14px；桌面 E2E 增加关闭菜单后重新按 W 确实移动的断言，手机 E2E 增加辅助文字字号断言。改动文件为 `game/client/src/settings.ts`、`game/client/src/settings.css`、`game/tests/e2e/x-settings.spec.ts` 和本交接。

这份最终改动已通过同一 heavy gate 下的 typecheck、5 文件 / 53 项单测、client build（123 modules）/ precompress / server build（87 modules）/ 导航（4069 nodes、0 failures），全部 exit 0。仅有既有的大 chunk 警告。随后经 browser gate 复跑同一设置命令：**3 passed（12.4 s），exit 0**，包含新增的关闭后恢复移动与手机字号断言。最终截图已重新亲自查看。

本分支手机基线采用“互动”按钮；直接点物体由其他 lane 集成，本次未验证 direct object tap。画面氛围 lane 的后续 fx / DPR / overlay 合并需复验设置开关与安全区，未跨树修改或验证。全量 check 和部署由集成代理串行负责；本 lane 不自行部署。
