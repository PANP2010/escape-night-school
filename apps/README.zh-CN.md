# 逃离夜校 0.6.3 应用

Windows 和 macOS 内置完整游戏服务；Android 内置客户端，需要连接云端或局域网电脑。

桌面选择「本地游玩」可离线单人游戏，服务只监听本机。选择「局域网开房」后，把「朋友加入地址」复制给连接同一 Wi-Fi 的朋友；房主点击「房主进入校园」并创建房间。朋友用浏览器打开该地址，或在桌面在线组队、Android 的服务器地址中粘贴，再加入同一房间码。系统若询问局域网或防火墙权限，请允许。关闭游戏窗口或退出房主应用会结束该服务，重新开房时地址端口可能变化。

多个网络地址时，选择与朋友设备处于同一网段的地址。手机不要填写 `127.0.0.1`，它代表手机本身。Android 不提供离线游戏服务器。

本地榜单保存在桌面应用用户数据目录，不写入安装目录。应用壳不捆绑签名私钥、模型凭据或依赖缓存。

## 重建

在 `apps` 执行 `npm ci` 和 `npm run icons`，然后运行：

```sh
GAME_ROOT=/path/to/committed/game npm run prepare:game
npm test
npm run desktop:mac
npm run desktop:win
```

也可使用 `npm run prepare:game -- --game /path/to/game`。源码需先提交；检查中的候选版可显式传 `--allow-dirty`，元数据会记录该事实。`stage/`、`output/` 和 Android 生成资源均位于当前应用工作区；`ESCAPE_STAGE_ROOT` 可覆盖准备目录。打包器默认消费 `stage/runtime`。

Android 在 `android` 执行 Gradle `assembleRelease`。需 Android SDK 35、JDK 17 和 Gradle 8.11.1；签名通过 `ESCAPE_ANDROID_KEYSTORE`、`ESCAPE_ANDROID_STORE_PASSWORD`、`ESCAPE_ANDROID_KEY_PASSWORD` 注入，不要提交这些值。Windows 和 macOS 包可分别选择 x64、arm64 架构，输出到 `output/desktop`。
