# 源码与安装包重建

产品源码在 `game/`（八章网页客户端和联机服务器）及 `apps/`（桌面与 Android）。`docs/README.md` 说明玩法。发布目录的 `release-manifest.json` 和 `SHA256SUMS.txt` 记录实际文件与来源提交；私钥、服务器密码和生成服务凭据不属于源码包。

## 网页和服务器

使用 Node.js 22.18 或更新版本和 npm。先在 `game/` 执行：

```sh
npm ci
npm run build
npm start
```

默认服务器端口为 4100。可通过 `PORT`、`HOST`、`DIST` 和 `NAV_CACHE` 指定监听地址与资源位置。正式服务设置 `NODE_ENV=production`；普通房拒绝调试指令，专用开发房仅允许当前绑定的开发者房主使用测试工具，且永不计排行。完整验证执行 `npm run check`；测试和浏览器依赖的安装按 Playwright 提示执行 `npx playwright install chromium`。

## 生成公共应用资源

网页源码应已提交，工作区保持干净。然后在 `apps/` 执行：

```sh
npm ci
npm run prepare:game -- --game ../game
npm test
```

该步骤从同一份源码构建桌面本地服务器、网页客户端、Android 内置客户端、卡通封面、启动画面和各平台图标。输出在 `apps/stage/`，版本与章节数自动读取游戏源码。原始生成图片和文字提示附在源码包的 `art-source/`。

## macOS 和 Windows

在 macOS 上构建两种架构的 DMG：

```sh
npm run desktop:mac
```

应用使用本机临时签名，不包含 Apple Developer ID 或公证。首次打开时可能需要在系统设置的“隐私与安全性”允许打开。Intel 与 Apple Silicon 分别选择 `mac-x64.dmg` 和 `mac-arm64.dmg`。

Windows 安装包可在 Windows 上执行：

```sh
npm run desktop:win
```

输出包含 x64、ARM64 和自动选择架构的合并安装包。当前 EXE 没有商业代码签名。跨平台构建使用 electron-builder 支持的 NSIS 工具；Apple Silicon 主机若使用系统原生 `makensis`，需通过 `ELECTRON_BUILDER_NSIS_DIR` 指定包含 `makensis` 和 `elevate.exe` 的目录，通过 `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` 指定官方 NSIS 插件资源目录。

桌面“本地游玩”会启动随包附带的服务，无需连接公网；“在线组队”使用启动界面填写的 HTTP(S) 服务器。

## Android

使用 JDK 17 或更新版本、Android SDK 35 / Build Tools 35.0.0、Gradle 8.11.1。设置 `JAVA_HOME`、`ANDROID_HOME` 后，在 `apps/android/` 执行：

```sh
gradle --no-daemon :app:assembleRelease
```

正式发布时由环境变量提供 `ESCAPE_ANDROID_KEYSTORE`、`ESCAPE_ANDROID_STORE_PASSWORD` 和 `ESCAPE_ANDROID_KEY_PASSWORD`，密钥别名为 `escape-night-school`。自行重建须使用自己的签名密钥。发布者的签名私钥不附带在源码中。

Android 包内含网页资源，游戏进度与多人房间通过网络服务器运行。默认连接发布服务器，也可在封面下方设置自己的服务器。Android 8.0 起可安装；首次侧载按系统提示允许当前来源安装应用。

## 验证边界

以发布目录的验收 JSON 和日志为准。构建成功、静态架构检查、模拟器验证和实际设备运行分别记录，未执行的平台实机验证不视为已通过。
