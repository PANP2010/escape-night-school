# 第三方许可说明 / Third-party notices

本项目的 MIT 许可证仅适用于本项目有权授权的内容，不替代第三方组件的原始许可证。下表列出核心运行组件，并非完整的传递依赖清单。

The project's MIT license covers only content it has the right to license. It does not replace third-party licenses. The table lists core runtime components, not every transitive dependency.

| 组件 / Component | 用途 / Purpose | 许可 / License |
| --- | --- | --- |
| [Three.js](https://github.com/mrdoob/three.js/blob/dev/LICENSE) | WebGL 场景 / WebGL rendering | MIT |
| [ws](https://github.com/websockets/ws/blob/master/LICENSE) | WebSocket 服务 / WebSocket server | MIT |
| [Electron](https://github.com/electron/electron/blob/main/LICENSE) | 桌面运行时 / Desktop runtime | MIT；附带组件另有许可 / bundled components have additional licenses |
| [Node.js](https://github.com/nodejs/node/blob/main/LICENSE) | 服务运行时 / Server runtime | MIT；附带组件另有许可 / bundled components have additional licenses |

完整依赖版本记录在 [`game/package-lock.json`](game/package-lock.json) 和 [`apps/package-lock.json`](apps/package-lock.json)，各包内的许可文件是对应发行包的依据。构建工具及其依赖也保留各自许可证。

Exact dependency versions are recorded in [`game/package-lock.json`](game/package-lock.json) and [`apps/package-lock.json`](apps/package-lock.json). Consult the license files shipped with each package for the corresponding distribution. Build tools and their dependencies retain their own licenses as well.

重新打包或分发时，请保留适用的版权及许可文件，包括 Electron 随附的许可文件、Chromium 的第三方许可和 Node.js 组件声明。Android 系统 WebView 由设备系统提供，并不因本项目采用 MIT 而改变许可。

When repackaging or distributing builds, retain applicable copyright and license files, including Electron's license files, Chromium third-party licenses, and Node.js component notices. Android's system WebView is provided by the device and is not relicensed by this project.
