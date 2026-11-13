# GPU 验收机（G2 / iter 12）

只使用 `uhost-1xl0i3stj2qh`（escape-gate-3080ti，3080Ti 12G / 12 核 / 32G）。
本任务不改变本机闸门或部署流程。以下命令从仓库根 `/root/escape` 运行；在 `game/` 下使用 `../tools/gpu`。

## 使用

```sh
tools/gpu status
tools/gpu run -- npx playwright test -c playwright.gate.config.ts smoke
tools/gpu run -- npx playwright test -c playwright.gate.config.ts
tools/gpu run -- node tests/gpu-acceptance.mjs
tools/gpu stop
```

`run` 启动指定实例，等待 Running 与 SSH 就绪，打包并上传当前 `game/` 工作树，
安装缺失依赖，验证实际 NVIDIA WebGL 渲染器，构建，再原样执行命令。
退出时取回远端 `test-results/` 到本机 `game/test-results/`，随后停止实例并独立查询确认 `State=Stopped`。
命令失败和 INT/TERM/HUP 都走同一个清理入口；清理期间屏蔽二次信号，外层强制时限仍有效。结果下载或关机确认失败会使工具失败。
总执行限时 31 分钟，额外预留最多 8 分钟清理（总计39分钟）；重复 run 由本机锁拒绝。

排除 `node_modules`、`dist*`、`test-results`、`.green*`、缓存和旧 release；源码删除也会同步。
凭据仅通过 `. /root/.config/compshare/env` 加载，不放进命令参数或上传包。
CLI 的 askpass 目录固定加入 PATH；刚开机的 SSH 拒绝连接会在 150 秒内重试。

## 安装与渲染

登录用户实际为 `ubuntu`（uid 1000），工作目录 `/home/ubuntu/escape-gpu/game`，系统依赖通过免密 sudo 安装。
首次下载与本机 `node -v` 完全一致的官方 Node 二进制并核验 SHA256，之后复用。
`npm ci` 缓存键包括 Node 版本、package.json、package-lock.json 和 .npmrc；变更时重新安装。
Playwright 版本变更时重新执行 `npx playwright install --with-deps chromium`。
若本机具备同锁定版本的 Chromium、headless-shell 和 FFmpeg 缓存，工具先按修订号打包传输；
远端已有完整缓存则跳过。不会复制本机 `.links` 或系统依赖验证标记，远端仍执行上述安装命令。
这避免中国节点从 Chrome CDN 极慢下载（首次实测数分钟仅约 13 MB）；没有本机缓存时回退远端下载。

远端设置 `ESC_GPU=1`，清除 `ESC_SOFTWARE_GL`；本机默认 SwiftShader / macOS Metal 参数不变。
Linux GPU 分支使用 headless Chromium + ANGLE Vulkan，并保留场景自己的 features。
每条命令前读取 `WEBGL_debug_renderer_info`，必须包含 NVIDIA，且不得包含 SwiftShader、llvmpipe、lavapipe 或 software。
完整采样另检查实际游戏 WebGL context，避免只证明一张空白 canvas。
参数依据：[Chromium 文档](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/using-gpu-hardware-in-headless-chrome.md)、
[Chrome 官方 NVIDIA 示例](https://developer.chrome.com/blog/supercharge-web-ai-testing)。

## 实测（2026-11-11）

本机真实 Chromium 的反例基线为 SwiftShader，renderer-only 探针确实失败（exit 1）；
证据 `game/test-results/g12-local-software-baseline.json`。

| 项目 | 本轮实测 |
| --- | --- |
| GPU / Node / Playwright / Chromium | RTX 3080 Ti / v22.20.0 / 1.63.0 / 153.0.8010.12 |
| GPU smoke | 首次1/1通过12.4秒；最终精确命令1/1通过11.5秒，整个工具退出0并确认Stopped |
| GPU 闸门 e2e 子集 | 14/14 通过，无重试，3.4 分钟 |
| L1 1080p 30 秒 | 60.0207 FPS；30006.3 ms，1801 rAF / 实际绘制帧，599 个 WS 快照 |
| 画面 | 1920×1080，实际游戏 context 为 NVIDIA，未丢失；截图已亲自查看 |

实际 renderer（空白检查及游戏 context 均相同）：
`ANGLE (NVIDIA, Vulkan 1.4.303 (NVIDIA NVIDIA GeForce RTX 3080 Ti (0x00002208)), NVIDIA)`。

L1 口径为开局 presentationReady、intro 结束后的 30 秒，
1920×1080、pixelRatio=1、关闭后处理，与现有 gate 低画质设置一致，记录 rAF 与实际绘制帧数、WS 快照数。
本机历史参考：任务给定约 25 分钟；iter 11 完整 check 实测约 20.5 分钟，其中 e2e 约 7.8 分钟。
GPU e2e 3.4 分钟对比本机历史 e2e 7.8 分钟，约快 2.3 倍；CPU 核数和渲染后端同时变化，不能归因于单个因素。
本轮没有把单测或闸门搬到 GPU。最终本机 `npm run check` 实际退出0：186个单测文件、1888项通过/1个原有skip，构建通过，14项e2e无重试7.8分钟，`.green`生成；日志`g12-final-check-confirmed.log`，退出码`g12-final-check.exit`。

证据：`game/test-results/g12-gpu-seeded.log`（smoke、完整14项e2e及硬件渲染器），
`g12-gpu-fps.log`、`g12-gpu-acceptance.json`（成功30秒采样），
`g12-gpu-final-smoke.log`与`.exit`（精确验收命令整体退出0、State=Stopped），
[1080p 截图](../loop-codex/shots/iter-12.png)。
首次采样把 L1 写成 index=1 导致超时，已修为真实 index=0，并用真实关卡定义的6项单测保护；
原失败报告保留在 `g12-first-acceptance-failure.json`。

## 首次接入发现

- `/root` 对 ubuntu 不可写：上传和工作目录必须使用 ubuntu 家目录。
- 停止 API 的 `226609` 表示生命周期操作仍持锁，状态可能仍显示 Running；先轮询，再有界重发 stop，总停止窗口300秒，必须独立确认 Stopped。
- 原始运行日志 `game/test-results/g12-gpu-cold*.log`；关机恢复日志 `g12-stop-recovery.log`。

最终资源状态：`game/test-results/g12-final-status.txt` 记录 `uhost-1xl0i3stj2qh State=Stopped`（16:28 UTC再次确认）；本轮只操作此实例，累计开机约37分钟。
