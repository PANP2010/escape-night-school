Playwright 的配置、spec 和独立 `.mjs` 脚本统一调用 `browserArgs()`（`browser-args.mjs`）：

- macOS 默认 `--use-angle=metal`，移除软件模式专用的 `--disable-gpu-compositing`。
- Linux 等其他平台使用 SwiftShader 绘制 WebGL，并统一加 `--disable-gpu-compositing`，让 HUD 与截图图像在 CPU 合成，避免争用软件 GPU。
- `ESC_SOFTWARE_GL=1` 在 macOS 也启用同一套 SwiftShader 与 CPU 页面合成参数。
- `ESC_GPU=1` 仅在 Linux 显式启用 NVIDIA 验收使用的 headless ANGLE/Vulkan；`ESC_SOFTWARE_GL=1` 优先。
- 每个场景的后台计时、进程数量、vsync 参数保持原样；后端选择由 helper 统一控制。

真实 GPU 验收在 `game/` 下运行。先在一个终端启动已构建的服务：

```sh
PORT=4290 HOST=127.0.0.1 npm start
```

再运行探针：

```sh
node tests/probe-gpu.mjs
ESC_SOFTWARE_GL=1 node tests/probe-gpu.mjs
ESC_GPU=1 node tests/probe-gpu.mjs
```

探针启动两个独立 Chromium，通过真实 WebSocket 加入同一房间，同时持续绘制。
它读取游戏实际 WebGL context 的 `WEBGL_debug_renderer_info`，验证本机 Apple/Metal
或回退模式的 SwiftShader、实际绘制帧增量及双方远端玩家 ID；JSON 和截图分别保存到
`test-results/gpu-probe-metal/`、`test-results/gpu-probe-software/`。
Linux NVIDIA 模式保存到 `test-results/gpu-probe-nvidia/`，必须由真实 renderer 字符串确认 NVIDIA。

云 GPU 入口与实测数据见 `../docs/gpu.md`。单独的 `ESC_GPU=1 node tests/gpu-acceptance.mjs --renderer-only`
无需服务器，先断言 WebGL2 renderer 为 NVIDIA；去掉 `--renderer-only` 则自动启动已有构建的服务，
从 L1 开局可操作后采样 30 秒平均 rAF 帧率与实际 WebGL 绘制帧增量，保存 `test-results/gpu/acceptance.json`
和 1920×1080 的 `l1-1080p.png`。画质沿用本机闸门的 pixelRatio=1、postprocessing=false；没有关闭游戏绘制。

本地跑 Playwright 时使用独立临时 config，将 `webServer` 与 `use.baseURL` 同时覆盖为
4290，并设置独立的 `outputDir`。例如先创建
`game/test-results/gpuinfra/playwright.local.config.ts`（相对路径以此文件为准）：

```ts
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../../playwright.config.ts';

const baseURL = 'http://127.0.0.1:4290';
export default defineConfig({
  ...base,
  testDir: '../../tests/e2e',
  outputDir: './artifacts',
  use: { ...base.use, baseURL },
  webServer: {
    command: 'PORT=4290 HOST=127.0.0.1 node dist-server/index.js',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
```

这里在同一个配置对象中覆盖整个 `webServer`；多参数的
`defineConfig(base, overrides)` 会合并两个服务配置，导致原端口也被检查或启动。
运行前先结束自己为探针启动的 4290 服务，由 Playwright 管理测试服务：

```sh
UI_TAG=gpuinfra node node_modules/@playwright/test/cli.js test \
  -c test-results/gpuinfra/playwright.local.config.ts \
  smoke.spec.ts x-interact.spec.ts x-ui-shots.spec.ts x-l2-dark.spec.ts \
  x-rubber.spec.ts x-multi.spec.ts x-lowfps-remote.spec.ts
```

保留所有既有场景、断言及 CPU 节流调用；平台不支持的
CPU 节流协议应如实报错，不得通过 skip 或删除断言隐藏。

探针每次运行前清理当前模式的两张截图和 JSON，再保存本次结果。
采样或断言失败时仍保留两端可获得的采样信息；以 `renderer.json` 中的 `passed`
与进程退出码判定通过，不能仅凭生成了截图判定。
