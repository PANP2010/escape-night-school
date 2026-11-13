# 空间音频离线复验方法

本方法验证 `game/client/src/sound.ts` 的实际 WebAudio 音效图，台词仍由既有动森式 `voice.ts` 处理。运行结果以 `game/test-results/audio-spatial/report.json` 为准。

先确认 4422 空闲，在本工作树 `game/` 用已有依赖启动 Vite 源码服务。显式指定本树缓存目录，避免共享 `node_modules` 中的缓存写入：

```sh
cd game
node --input-type=module -e 'import { createServer } from "vite"; import { resolve } from "node:path"; const server = await createServer({ configLoader: "runner", cacheDir: resolve("test-results/audio-spatial/vite-cache"), server: { host: "127.0.0.1", port: 4422, strictPort: true } }); await server.listen(); server.printUrls();'
```

另一个终端在本树 `game/`，由统一 browser gate 串行运行。验证结束关闭自己启动的 Vite 进程：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node tests/probe-audio-spatial.mjs
```

脚本不会启动服务、构建产物或游戏服务器，不连接 WebSocket，不请求麦克风，不截图、不录像。它只启动一个 headless Chromium 会话，复用 `tests/browser-args.mjs` 的 Metal/软件后端选择，并显式传入 `--mute-audio`。离线输出仅写 WAV 文件，不调用声音播放接口。

## 原生波形验证

同源最小页面经 Vite 导入源 TS，以真实按钮点击解锁 `Sound`。`document`、`navigator`、用户激活检查和全部音频节点都保留浏览器原生实现。为了满足 `Sound.ready()` 的运行态门控，离线构造器只适配渲染前的 `state`、`resume`、`suspend`、`close`；`OfflineAudioContext`、Gain、Filter、StereoPanner、Compressor、自动化及双声道渲染均为原生实现。该适配的状态不作为生命周期证据。

先在锁定时设置 active frame，随后解锁，不再更新环境床音，因而可单独测出事件链路的频谱和声道能量。先原生渲染 125 ms 静音并暂停，使 preferences 的 25 ms 音量缓动自然稳定，再调用公开 `footstep` / `door` 并原生继续离线渲染。每一对只改变被测条件；固定随机种子使噪声内容、播放速率和起点一致。所有声音最终通过 `Sound` 实际总线与压缩器到达离线 destination。

输出为 48 kHz、双声道、32 位浮点 WAV；保留浮点峰值而不以整数编码削波掩盖缺陷。数值断言包含：

- 左右声源的主耳差至少 5 dB；固定世界声源在 yaw 半转后换耳；正前方经四分之一转成为右侧。
- 同为水平 4 m，源在下一层时 RMS 与 1.5–8 kHz 能量占比下降；额外楼板和墙体通过真实 `CollisionWorld` / `lineOfSight` 产生遮挡，再验证幅度与高频下降。
- 楼层案例明确区分眼高和脚步高度：听者一层眼高 `y=5.2`，同层脚步 `y=3.75`、下一层脚步 `y=0.15`。同层眼脚间 1.45 m 高差不是跨层。
- 开门吱呀的 1%–99% 累积能量时长大于关门闷响；关门瞬态更强。
- 同一源的室内脚步比室外脚步保留更多高频；换听者室内/外状态不会覆盖源端材质参数。
- 总音量减半后的 RMS 为原值的 0.45–0.55；静音拒绝事件且渲染结果为精确数字零。
- 各波形必须有限、峰值低于 0.95，并确认实际事件节点含原生 `StereoPannerNode`。

脚本另用 12 个固定种子审计居中近身脚步的左右 RMS 偏差，要求每次偏差不超过 3 dB。独立立体声噪声可令短促音效自然偏向某耳，因此同时保留每个种子的结果；这一审计不能替代左右路由断言。

## 原生生命周期验证

同一浏览器会话中恢复真正的 `AudioContext`，只统计原生 `resume` / `suspend` 调用，不替换节点或状态。验证锁定时事件不创建上下文、可信手势解锁、音量零与静音清空声源，以及 preferences setter 不自行创建或恢复上下文。

两组可信 handler 顺序分别执行 `unlock(); pause()` 与 `pause(); unlock()`，保留每一步即时 state，并检查最终 suspended / running 状态。若浏览器没有命中延迟状态竞争窗口，报告只声称本次最终状态正确；不以此冒充浏览器 race 复现。

脚本先尝试同浏览器的后台标签，再尝试原生窗口最小化，以真实 `document.hidden` 和 visibility 事件验证停止、暂停及回前台不自行恢复。若该 headless 宿主不提供隐藏状态，JSON 明确给出 `visibilityVerified: false`，不会把模拟事件或篡改 `document.hidden` 当作通过。最后执行真实页面导航，通过 `isTrusted: true` 的原生 `pagehide` 记录确认声音释放。

每个案例的输入、节点类型、RMS、声道差、峰值、频谱指标和断言均保存在报告中。此方法不包含人工试听或恐怖感评分；这些结论需要另行审听，不能由离线数值推断。

## 本切片修复范围

本切片基于 `bc27636`，保留已有的后台控制消息竞争修复、角色074追击动画识别、动森式语音及 L1–L4 内容。

- 跨层声源原先只增加距离衰减。实际脚步有自己的 600–950 Hz 材质低通，原距离低通仍过高，下一层高频占比几乎不变。现在耳脚高差 2 m 内保留原规则，更大高度差连续降低截止频率；真实碰撞遮挡继续增加衰减与低通。
- 近处值日生冲刺原先仍乘以远处角色074的距离强度，结果可能完全无威胁声音。现在按追击者自己的距离计算，与角色074巡逻的低强度环境层取较大值。
- 队友蹲姿的渲染高度降低了 0.5 m，原音源直接使用渲染高度，误落到楼板下。现在将脚步源还原到地面上方，再做遮挡、材质与声像判断。

## 本树实际验证

2026-11-05，统一 heavy gate 内类型检查通过，`sound`、`sound_threat`、`fx`、`client_loop`、`loop_view` 五文件共 77 项测试通过（`--maxWorkers=1 --configLoader runner --no-cache --no-fsModuleCache`）。没有执行全量 `npm run check` 或构建。

独立纯 Node 验证使用共享 `CollisionWorld` 与 `lineOfSight`：3.6 m 层的蹲行脚步源由 3.25 m 恢复到 3.75 m，同层楼板射线由遮挡变为通畅，与站立声源一致；证据为 `game/test-results/audio-spatial/crouch-floor.json`。实际 `soundSpace` 的跨层截止频率由 2395.65 Hz 降至 492.42 Hz，距离、增益与声像不变；证据为同目录 `floor-cutoff-check.json`。

产品提交 `e8df5a1` 的原生复测为 **80/80 通过**。同一 headless Chromium 153.0.8010.12 会话使用 `--use-angle=metal --mute-audio`，导出 29 个 48 kHz 双声道浮点 WAV，最大峰值 0.02617605，无削波、无浏览器错误；源码 SHA-256 在执行前后相同，为 `a08eca430cfb58416aea19a1065524fadb1af03754b2be9bdd31186f4e80d7cf`。

| 原生测量 | 实测结果 |
|---|---|
| 左右源主耳差 | 右源 +14.36 dB、左源 −15.11 dB；转头后换耳 |
| 下一层 / 同层脚步 RMS | 0.31086 |
| 下一层 / 同层 1.5–8 kHz 能量占比 | 修前 0.93348，修后 0.00853 |
| 真实楼板遮挡 / 跨层清晰通道 | RMS 0.17468，高频占比 0.04073 |
| 总音量减半 | RMS 比 0.50230；静音为精确数字零 |
| 中心脚步 12 个固定种子 | 最大偏耳 1.68265 dB，全部小于 3 dB |

原生可信手势的 unlock→pause 与 pause→unlock 序列最终状态正确，真实导航的 `pagehide.isTrusted=true` 且声源数清零。宿主不暴露真实隐藏状态，`visibilityVerified=false`；没有通过模拟事件补成通过。修前报告保留在 `baseline-report.json`；其中 pagehide 缺记录是探针传输方式问题，最终改为真实事件内同步保存、导航后读取，并非产品修复。

验证过程首次 Vite 启动未显式隔离默认缓存，随后已停止并切换本树缓存；复现命令还使用 runner 配置加载，避免默认临时配置写入共享依赖目录。没有安装或更新依赖包。

## 尚未覆盖的体验

本切片没有真机 Safari/手机试听或恐怖感评分。headless 是否提供真实后台隐藏状态由报告明确记录，不能以模拟事件代替。系统中文朗读没有调用，语音实现没有修改。

当前主怪尚未接入定位脚步；有限事件使用 StereoPanner，没有 HRTF；追击反馈使用既有威胁床音与心跳，没有独立音乐轨。首次从静音或零音量恢复的部分路径仍需下一次用户手势（例如关闭设置），属于偏好交互的后续边界。合并后的全量检查与部署由集成代理执行。
