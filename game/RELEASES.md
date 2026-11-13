游戏更新记录的唯一来源是 `client/public/version.json`。每次对玩家发布新版本时，更新稳定且唯一的 `id`、发布日期 `date`（YYYY-MM-DD）和简短中文 `entries`，只写该次实际发布的内容。相同构建的重试部署保留同一个 id。

Vite 将这份记录嵌入客户端，并原样复制到 `dist/version.json`；现有 green staging 会连同整个 `dist` 一起发布。必须将客户端、版本记录和对应服务器作为同一次发布部署，不能单独提前上传版本记录。服务器的 `/version.json` 返回 JSON 和 `Cache-Control: no-store`，客户端也以 `cache: 'no-store'` 请求。

页面打开后先读取内置记录显示大厅内容，并为每个版本保存已查看标记。首次成功获取服务器记录仅建立基线，之后每 60 秒、页面重新可见或网络恢复时检查。旧页面即使在发布后才第一次获取记录，也会在后续检查提示刷新。失败和无效响应保持静默，不清除已检测到的更新。存储不可用时，已查看状态只在当前页面内保存。

游戏进行中只有不接收点击的通知，不自动刷新、不退出鼠标锁定、不改变游戏输入。玩家在大厅或通关后可点击或用键盘激活“刷新体验”。普通重试关卡或楼层切换仍属于本局，不提供中途刷新按钮。

验证：`npm run typecheck`、`npm run test -- tests/unit/release_state.test.ts`、`npm run build`、`npm run e2e -- tests/e2e/x-update-notice.spec.ts`。浏览器测试包含真实静态路由、首次基线、更新变化、刷新前联机快照持续、键盘操作、版本持久化隔离和禁用存储的手机横屏。
