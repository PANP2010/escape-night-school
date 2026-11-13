# 语音偏好与生命周期交接

本切片基于本 lane 已有的 `0526300`、`9755be9`、`343d876` 继续完成；未重放旧分支。部署由集成代理负责，本树未运行全量 `npm run check`。

## 产品改动与接线

- `voice.ts` 保留约 110 Hz 的低沉无词嘟囔、原用户字幕、距离衰减、旧 `0634a24` 的 attack 前取消条件 `ac.currentTime < t0`。没有系统 TTS 路径。
- 总音量经 Voice 的 master gain 生效；静音或零音量同步断开所有当前及淡出的语音源，保留字幕。恢复音量不补播旧句。
- 原生 `visibilitychange` / `pagehide` 取消声音并 suspend。回来后需要新的可信手势；旧的异步 resume 或延迟台词不能补播。
- 本轮补齐两个恢复时序：隐藏的 suspend promise 已完成、statechange 迟到时，不再误杀首句新对白；隐藏 suspend 被拒而上下文仍 running 时，及时结束恢复标记，避免后续设备中断留下旧声音。两项均先用新增单测在修复前确认失败。
- `BroadcastView` 现在使用 Game 拥有的同一个 Voice。第四关广播以前另建默认满音量的 Voice，会绕过偏好和退出清理；现在共用设置、取消及销毁，也不会双 Voice 同时写字幕。

集成时保留这些最小语义接线：

1. Game 的 `FeedbackSettings` 回调仍调用 `sound.setPreferences(p.volume, p.muted)`，同时调用 `voice.setPreferences(p.volume, p.muted)`。Sound 未作改动。
2. `new BroadcastView(...)` 最后传入 `this.voice`；BroadcastView.dispose 只清理自己拥有的界面和几何，不销毁共享 Voice。
3. Game 收到广播快照时将 `!feedbackDisposed && !completed && performance.now() >= fadeUntil` 作为 `receive` 的第三个参数。禁止发声时仍应用广播状态。
4. `fade`、`complete`、真实 `loadLevel`、`disposeFeedback` 都使 `voiceEpoch` 失效并取消/销毁 Voice。300ms 台词回调检查关卡 epoch，并使用收包时 `capturePlayback()` 的发声资格。
5. main 已有 `net.onClose` 与 `beforeunload -> disposeFeedback()`，无需新增 main 改动。语义合并时保留集成树已有的 awaitingLevel、capture、touchPending 等逻辑。

本树的 `mob.at` 仍是 `[x,z]`。若集成 `monitor7b3b922` 后变成 `[x,y,z]`，将延迟台词距离调用和 `game_voice_lifecycle.test.ts` 中的坐标桩一起适配；不要沿用本树的 `at[1] - camera.z`。

## 实际验证

所有 typecheck / vitest / build 均经 `parallel_sprint.py gate heavy --`；浏览器均经 `gate browser --`，只运行单个 Chromium，使用 Metal 和 `--mute-audio`。

- `tsc --noEmit`：通过。
- 定向 vitest：4 文件、70 项通过，参数 `--maxWorkers=1`。覆盖 Voice、字幕门控、Game 延迟台词边界、广播消息边界及 L3 原有回归。
- `npm run build:client`：通过；仅有已有的大 bundle 提示。
- `playwright.voice-preferences.config.ts`：5 项通过，0 retry，37.7 秒。使用本树构建产物、端口 4443。新增 L4 客户端用生产 BroadcastView 和广播快照测静音、fade 和离开广播关后的新对白；完整 L4 解谜/服务器通关由其独立回归负责。
- 原生 OfflineAudioContext：25% 音量的稳定段 RMS 比为 `0.2500000000208263`；预先静音、零音量、attack 前取消均为精确零 PCM；正在发声时静音或取消后 RMS / peak 均为 0。
- 原生标签切换：`document.hidden=true` 且事件 `isTrusted=true`；AudioContext 为 suspended，playing / connectedSources 为 0；250ms 后音频时钟仍为 `0.4693333333333333`，没有推进。返回前台仍不恢复声音，直至新可信手势；新手势不补播旧句。
- 原生 dispose：AudioContext closed，源与连接为 0；后续调用和手势不能再创建声音。所有系统语音 API 访问次数为 0。
- 构建版 PCM：近距主频约 105.47 Hz；60–450 Hz 能量占约 99.3%。设置静音、L4 广播静音和 fade 后广播的 RMS / peak 均为 0。
- 已亲自查看 `voice-browser--keyboard-subtitle.png` 和 `voice-browser--touch-server-subtitle.png`。它们使用 `?nodraw` 验字幕布局，不作为游戏画面评分。

证据留在本树 `game/test-results/voice-preferences/`、`game/test-results/voice-existing/` 及 `game/test-results/voice-browser--*`，没有提交生成证据、dist 或 node_modules。测试服务器 PID 68363、76332 均由本次任务启动并已关闭，端口 4443 已无监听。

## 验证边界

- 真正的标签隐藏通过浏览器原生事件、源断开和停止的音频时钟验证；精确零 PCM 来自离线渲染和前台静音/取消。没有声称采到了已 suspend 的后台 PCM。
- pagehide/pageshow 使用合成 PageTransitionEvent 检查真实 AudioContext 的处理，不等同于原生导航/BFCache 测试。iOS Safari 真机、完整 BFCache 恢复仍需集成复验。
- 未录视频，未做 Gemini 外部评分。全量验收与部署仍交集成代理执行。

原生探针通过临时独立 profile 启动 Chromium，再用 `connectOverCDP({ noDefaults: true })` 附着默认 context。此前尝试在另一个 CDP session 关闭焦点模拟，无法撤掉 Playwright 自己 session 的默认覆盖，会使切标签后仍然 hidden=false；本轮修正了此测试设施，没有修改 document.hidden 或放宽断言。
