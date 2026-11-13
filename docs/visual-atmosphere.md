# 局部照明与胶片氛围验收

以下是验收脚本设计与复现方法，不代表浏览器已经执行或视觉通过。最终状态：18:54 检查 PID 12733 仅为等待锁的 parent，无 child；validation 只向自己的排队进程发送 TERM，session 53907 退出码 143。4451 无监听，本 lane 从未启动浏览器或服务器。累计等待为先前约 36 分钟，加本轮约 13 分 45 秒；本地状态证据为 `game/test-results/visual-atmosphere-browser-unexecuted.json`。

没有截图、真实 FPS 或外部视频评分；截图目视、桌面/手机效果开关、L2 最暗状态与边界验收均未完成，尚无视觉测量数据。

此切片以 `2174268` 为基线，产品提交为 `56047f2` 与 `894519c`，计划验证 L1 历史机位 `l1-5` 的墙地照明、胶片细粒与暗角开关，以及 L2 普通停电和最暗状态的脚下可读性。L1 地标实际位于西南楼梯前厅 sc0；历史任务仍称它为「亮着的教室」。

脚本计划顺序执行基线画面、新版本画面与等价边界验证，每次 CLI 使用一个 Chromium session，任一时刻只有一个；桌面 1280×720 与手机横屏 844×390 contexts 串行采样，ANGLE 配置为 Metal。另在同一个桌面机位采集 1920×1080 效果开/关各两秒真实帧。全部浏览器命令经过共享 browser gate，启动参数包含 `--mute-audio`，独立服务器只用 4451。`?steady` 固定场景闪烁和颗粒，游戏持续 `draw=true`；rAF 帧间隔与 `renderer.info.render.frame` 增量同时采集并断言真实绘制。每项帧率另列 `budget50FpsOnThisRun`，采样值仅描述本机本次运行，不能作为集显 1080p ≥50 fps 的承诺。

可复现机位：

| 场景 | x / z | yaw / pitch | 状态 |
|---|---|---|---|
| L1 l1-5 | -56.2 / 70.5 | π/2 / -0.15 | 无手电，前厅内朝西 |
| L1 回看 | -62.6 / 69.2 | -π/2 / -0.12 | 无手电，前厅另一朝向 |
| L2 走廊 | 46 / 84.2 | π/2 / -0.08 | 普通停电、跳闸最暗分别采样 |
| L2 教室 | 36.4 / 77.3 | -π/2 / -0.08 | 普通停电、跳闸最暗分别采样 |

普通停电采样前等待 `abs(campus.eye - 0.4) < 0.01`，跳闸采样前等待 `out=1 && eye>0.97`；每张截图后都记录并断言 blackout、out、eye 与关闭手电状态。保留最暗原标准：下中央三分之一地面均值 ≥22、全图均值 ≤45，走廊地面均值大于两侧墙裙均值的 1.15 倍。

局部解析光 A/B 用 `campus.setLandmarks(undefined)` 与 `campus.setLandmarks(level.def.landmarks)`；效果 A/B 用 `game.atmosphere.setEnabled(false/true)`。另验证 `escape:settings-change` 自定义事件、`escape.settings.postprocessing` 存储重载、桌面默认开与手机默认关。设置菜单本体属于其他 lane，合并时需在它的 onChange 中调用 `game.atmosphere.setEnabled(preferences.postprocessing)`；本切片已提供事件兼容入口。

复现命令（运行前确认 4451 空闲）：

```sh
cd game
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- env ESC_VISUAL_PHASE=after npx playwright test -c playwright.visual-atmosphere.config.ts
```

本次为避免重复浏览器排队，在构建新版本前把基线 `dist`、`dist-server`、`.cache`、`package.json` 完整快照到 `game/test-results/baseline-server`，并在 `baseline.json` 保存原 index 资产引用及 index/server/nav 三项 SHA-256。baseline 配置用 `DIST`、`NAV_CACHE` 和旧服务器路径读取快照，客户端还断言氛围模块不存在。新版本构建完成后，`gate browser -- node tests/visual-atmosphere/run-comparison.mjs` 会先校验快照哈希，再依次运行基线 visual、新版 visual、新版 bounds 三次 CLI，中间保持浏览器资源预约且完整关闭前次服务器/会话。当前代码的 after 采样可独立运行，无需该本地快照。

基线构建后用 `ESC_VISUAL_PHASE=baseline` 采集；基线数据预定写入 `game/test-results/visual-atmosphere-baseline/`，新数据预定写入 `game/test-results/visual-atmosphere-after/`。每组 `evidence.json` 记录亮度分位数、ROI 均值、renderer 字符串、draw calls、三角形、program 数、真实帧分位数、开关与 HUD DOM 状态。整页截图供人工看 HUD；独立 `*-scene.png` 在计时窗口外直接 render 后同任务复制物理 canvas，亮度同时报告整页与完全排除 DOM HUD 的 scene 统计。原始 canvas 裁图用于检查颗粒物理尺寸，HUD 明亮不透明字面另做像素 A/B；DOM 相同仅表示布局未变。生成截图与 JSON 保持为本地证据，不作为产品产物提交。

`x-bounds-single-session.spec.ts` 保留原 `tests/e2e/x-bounds.spec.ts` 的全部路线、碰撞/越界断言与截图机位，只将原来的两个 `chromium.launch()` 改为同一 fixture browser 的两个 contexts。文件头记录原脚本 SHA-256。本切片计划运行等价单 session 验证；它和原 spec 当前均尚未执行。

已执行的静态验证：相关定向单测 21/21 由实现代理通过 heavy gate 运行并通过（eye_light、campus_visual、own_torch、landmark_light、atmosphere）；gated typecheck 退出码 0，用时 2.85 s；gated build 退出码 0，用时 1.749 s，记录时间 `2026-11-05T10:39:31.875Z`；`git diff --check` 通过。静态日志位于 `game/test-results/visual-atmosphere-checks/`。浏览器结果与截图审查仅在实际运行后填入。
