# 胶片氛围接入说明

`game/client/src/atmosphere.ts` 的 `AtmosphereFx` 在主世界 scene 内绘制最后一个透明全屏三角形。沿用现有的一次 `renderer.render(scene, camera)`，增加 1 draw call / 1 triangle，不使用渲染目标、纹理或 EffectComposer。颗粒使用真实 framebuffer 像素；中性乘法混合保留黑位与 alpha，暗角最深为角落的 13%。DOM HUD 在 WebGL 后合成。

`game.ts` 已接入公开的 `game.atmosphere`、构造与 `disposeFeedback()` 释放。每次 `onBeforeRender` 读取当前物理 viewport，覆盖 resize、DPR 更改和 `tests/e2e/draw.ts` 的直接渲染截图。`?steady` 在构造时直接从 URL 读取，固定颗粒帧。

## 与 settings lane 合并

当前独立 lane 会读取 `escape.settings` 的布尔值 `postprocessing`（默认桌面开、触屏关），并监听 `document` 上的 `escape:settings-change` 自定义事件，其 `detail` 为 `{ postprocessing: boolean }`。

**设置菜单的实时接线仍需在集成时添加。** 外部 settings lane 的 `GameSettings` 在构造时就同步调用 `options.onChange`，因此必须先构造 `this.atmosphere`，再构造 `this.settings`。在 `game.ts` 现有 `GameSettings` 的 `onChange(p)` 中，紧接 `this.jasmine.setEnabled(p.postprocessing)` 添加：

```ts
this.atmosphere.setEnabled(p.postprocessing);
```

沿用已有 `GamePreferences.postprocessing`、`#settings-postprocessing` 与存储格式，无需增加另一套 effects 偏好。兼容事件可保留，或在完成直接接线后删除。

## 与 startup_render 合并

- 保留主 scene 内的 `film-atmosphere` mesh；分帧校园构建的临时 group 只替换校园内容，不清空主 scene。
- 已只读核对 startup_render lane：`CampusScene.prepare()` 创建独立临时 scene，构造器把其 children 移入主 scene；`discardPreparedCampus()` 的 `scene.clear()` 只用于取消临时构建。按该实现合并可保留原有 Atmosphere 实例；勿把 film mesh 移入临时 scene，否则取消时会连同其 GPU 资源释放。
- 保留一次世界 render 的路径；无需改变 `draw.ts` 的 `frame()`。
- `const q = new URLSearchParams(location.search)` 已提前到 renderer 构造后，合并时保留一次声明与 `steady: q.has('steady')`。
- `loadLevel()` 在 `buildBarriers()` 后还有照明子任务的一行 `this.campus.setLandmarks(this.level.def.landmarks)`，合并分帧构建时应在对应阶段保留。

## 验证入口与结果

开关：`game.atmosphere.setEnabled(false / true)`；状态：`game.atmosphere.enabled`。关闭后 mesh 不可见，Three 完全跳过该 draw；再次开启复用原有 GPU 资源。

定向验证命令：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run tests/unit/atmosphere.test.ts --maxWorkers=1
```

已执行的静态验证：

- Atmosphere 定向单测：2026-11-05 18:14:37 经 heavy gate 运行，退出码 0；1 个文件、3 个用例全部通过，117 ms，覆盖偏好损坏/拒绝存储、实时关闭与幂等释放、直接渲染时 resize/DPR 后的 physical viewport。
- 本切片相关定向单测共 21/21 通过 heavy gate（eye_light、campus_visual、own_torch、landmark_light、atmosphere）。
- gated typecheck 退出码 0，用时 2.85 s；日志 `game/test-results/visual-atmosphere-checks/typecheck.log`。
- gated build 退出码 0，用时 1.749 s；记录时间 `2026-11-05T10:39:31.875Z`，结果 `game/test-results/visual-atmosphere-checks/results.json`。
- `git diff --check` 通过。

最终浏览器状态：18:54 检查 PID 12733 仅为等待锁的 parent，无 child；validation 只向自己的排队进程发送 TERM，session 53907 退出码 143。4451 无监听，本 lane 从未启动浏览器或服务器。累计等待为先前约 36 分钟，加本轮约 13 分 45 秒；本地状态证据为 `game/test-results/visual-atmosphere-browser-unexecuted.json`。

没有截图、真实 FPS 或外部视频评分；截图目视、桌面/手机效果开关、L2 最暗状态与边界验收均未完成，不能宣称视觉或性能通过。主要集成残余是设置回调缺失、重复 `q` 声明，或错误地让临时校园场景拥有 film mesh。
