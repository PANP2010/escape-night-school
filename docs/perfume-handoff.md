# 茉莉之夜修复交接

本切片基于 `57a05ea`，仅改 Jasmine 特效、最小生命周期接线与专项验证。保留 L1–L4、已有声音、画面和更新通知；没有改角色074模型/动作/AI、voice、关卡或部署配置。

产品提交：`d3e1241`（`fx.ts`、`game.ts`、两份单测，共 4 个文件）。截图脚本、专项配置、E2E 与本交接另作验证提交。

## 根因与修复

- 真实旧构建在桌面与手机约 14 米时 `jasmine.lvl≈0.0045`，但 `opacity=0`：旧 `l<0.01` 阈值吞掉了 13.5–15 米的整个警告区间。修复后透明度连续随接近程度变化，14 米约 0.2，15 米外严格为 0。
- 旧 `ellipse closest-corner` 让每条直边中点落在半径的约 70.7%；8 米时透明中心恰为 71%，所以主要四角出现颗粒。改为 `ellipse 50% 50%`，使横竖屏的四条直边中点都处于外缘；近距离中心仍留空。
- 原特效早于 renderer canvas 建立。倒地时 canvas 的 CSS filter 会建立自己的层叠上下文，有遮盖风险。现在在 canvas 挂载后建立 Jasmine，仍用 z-index 0，位于 HUD（z-index 1）下。
- 原每帧固定 0.1 的平滑速度与帧数绑定。改为按真实 `rdt` 的指数渐变，纹理按 12 Hz 更新；保留 CPU 画布与 8 档 × 4 变体的 32 图缓存。颗粒仍为 1–2 CSS px，不拉伸、不加整屏黄色雾。

调用链原本就在运行：`Game.update → Mobs.update → 所有非 monitor 的 mesh 到 camera 的三维距离 → JasmineFx.update`。没有视线、朝向、同层判断，因此隔墙、身后以及垂直距离仍在 15 米内的不同楼层均可闻到；垂直距离会计入三维距离。没有为特效修改 AI，也没有伪造物体或香水瓶。

52/55 Hz 低频嗡声原本已由 `Sound` 的手势解锁、音量控制总线驱动。本次移除了 Jasmine 中从未被当前调用传入 AudioContext 的旧重复音频分支；实际 Sound、voice 与台词没有改动。专项浏览器始终使用 Metal、headless、`--mute-audio`，音频验收读取真实运行总线增益，不播放外放。

## 集成接线

`game/client/src/game.ts` 仅七处小接线：Jasmine 字段延迟到构造函数中 canvas 挂载后初始化；`disposeFeedback` 销毁特效；换关、fade、complete 时 reset；帧调用改为 `jasmine.update(wd, rdt)`。`JasmineFx.update(d, dt = 1/60)` 的第二参为秒数，提供幂等 `reset()/dispose()`。

与 capture/cinematic/audio_detail 合并时保留这些接线。香水必须在真实 canvas 上、HUD 与过场盖层下；香水按距离提示，不能因为怪物在视野外或被墙挡住而被音频选择 helper 一并过滤。全量 check 和部署由集成代理执行，本树不部署。

## 验证方式

所有构建、类型检查、Vitest 都经共享 `gate heavy`，浏览器经 `gate browser`，服务器仅端口 4416。入口：`game/playwright.jasmine.config.ts`，输出目录单独设为 `test-results/jasmine-playwright`，避免清空其他专项证据。

`tests/shot-jasmine.mjs` 使用真实构建服务器与真实 WebSocket；服务器 debug 指令只做摆位，并由服务器快照距离、客户端渲染距离双重校准，截图前后容差保持 0.3 米。17/14/8/3 米分别验证范围外、初闻、中距与近距。完整截图正常绘制真实 WebGL 场景；开关特效对照图只暂停 WebGL 重绘以固定背景，怪物同步与 Jasmine 本身继续运行。像素比较排除截图前后真实 HUD 包围框的并集，避免变化的字幕污染测量；透明触摸区不算 HUD。

新范围 E2E 验四条直边可见、中心无颗粒、距离内连续增强、范围外清空、嗡声增益单调、单个 overlay、真实 canvas 与正确层级。倒地 E2E 通过真实服务器 down 指令验证 CSS filter 场景。原 `x-jasmine.spec.ts` 保留。

实际通过：

- `npm run typecheck`。
- `npm run build:client`。
- `npx vitest run tests/unit/fx.test.ts tests/unit/client_loop.test.ts tests/unit/sound.test.ts --maxWorkers=1`：3 文件、62 条通过。
- `npx playwright test --config=playwright.jasmine.config.ts`：4 条通过、零重试、耗时 1.4 分钟；包括桌面距离、手机距离、真实倒地 filter 场景，以及未修改断言的原 `x-jasmine.spec.ts`。
- `git diff --check` 与三份 `.mjs` 的 `node --check` 通过。验证服务器已关闭，4416 无监听。

最终像素差值结果如下；屏边变化像素采用 RGB 最大差值 ≥6，所有样本的中心变化像素均为 0。距离列是截图时的真实客户端三维距离，服务端距离也满足目标 ±0.3 米。

| 设备 | 目标距离 | 渲染距离 | opacity | 屏边变化像素 | 屏边平均差值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 桌面 | 17m | 17.036m | 0 | 0 | 0 |
| 桌面 | 14m | 13.986m | 0.2062 | 1149 | 0.0788 |
| 桌面 | 8m | 7.992m | 1 | 2383 | 0.8319 |
| 桌面 | 3m | 3.009m | 1 | 5572 | 2.0003 |
| 手机 | 17m | 17.062m | 0 | 0 | 0 |
| 手机 | 14m | 14.037m | 0.201 | 215 | 0.0686 |
| 手机 | 8m | 8.019m | 1 | 415 | 0.6856 |
| 手机 | 3m | 3.059m | 1 | 1021 | 1.6987 |

本树证据（均不提交生成文件）：

- `game/test-results/jasmine-baseline/`：旧版真实构建的桌面、手机 17/14/8/3 米截图与 `report.json`。旧版 14 米 opacity=0；8 米四条直边可见像素数全为 0。旧构建经临时 Vite 配置读取基线提交文件生成，没有回退工作树。
- `game/test-results/jasmine-fixed-desktop/`、`game/test-results/jasmine-fixed-mobile/`：最终 17/14/8/3 米完整截图、off/on 对照图与 `report.json`。
- `game/test-results/jasmine-downed/`：真实倒地 3 米完整截图及 off/on 对照图。
- `game/test-results/jasmine-playwright/.last-run.json`：`status: passed`、`failedTests: []`。

桌面、手机全部距离截图及倒地截图均已亲自查看：远处无颗粒，接近时屏边连续增强，中央人物、通路与 HUD 文字清楚。没有视频或外部 Gemini 评分。

## 剩余风险与集成交付

手机验证为 Chromium 844×390 触屏模拟，尚未实测 iOS 真机。与 capture/cinematic/audio_detail 合并后需复验 canvas 层级及香水距离接线。完整 check、用户可见版本通知和最终部署由集成代理串行负责；本 lane 未部署。
