# 统一开场视觉接线

本切片只改入口外观与桌面启动页标记，不替换 `main.ts`、公共大厅、重连、叙事或设置逻辑。

网页入口保留原有的 `style.css`/`lobby.css` 粉笔黑板界面，`game/client/index.html` 不加载写实封面 CSS，也不添加 `school-cover` 类；公共大厅、等待状态和全部功能控件继续由原有样式负责。`cover.css` 仅作为旧嵌入入口的兼容文件，背景使用代码绘制的渐变与噪声，不引用黑板图片。游戏 HUD 与弹窗不在入口样式作用域中。

`apps/desktop/launcher.html` 与 `launcher.css` 保留全部已有 IPC 元素 ID，并继续使用现有 `launcher.js`；原生启动页读取 `apps/shared/chalk.css` 的代码绘制黑板。Android 启动页使用同一份 `chalk.css`。

打包前需要将所选择游戏源码中的 `client/public/cover/` 整目录复制到 `apps/desktop/cover/`。在现有 `prepare-game.mjs` 中，`source` 与 `apps` 已解析后即可加入以下两句（该脚本由主代理维护，本切片未重写）：

```js
await rm(join(apps, 'desktop/cover'), { recursive: true, force: true });
await cp(join(source, 'client/public/cover'), join(apps, 'desktop/cover'), { recursive: true });
```

现有 builder 的 `desktop/**` 会将它们一同打入 asar。Android 继续使用同一份打包后的网页大厅；图标与启动图统一从无人物的程序化校园门、走廊与警示灯几何图形生成。

角色074保留游戏内虚构角色标识与行为语义；应用封面和图标不使用人物肖像、外貌参考或身份关联素材。

封面资产为独立程序化绘制的虚构校园门、空走廊与警示灯；不含人物、姓名、肖像或真实学校标识。保留既有 WebP 文件名和 1100×1100 尺寸以兼容引用，黑板资产及按钮文字的显示规则不变。

验证已完成：typecheck、Vite client production build 通过。共享 browser gate 下，单个 Chromium/Metal/headless/mute-audio 会话验证 1440×900、1280×760、844×390 和 390×844 的公共大厅 fixture，均无水平溢出，所有输入/按钮在横向边界内；小屏可滚动到房间列表，加入按钮不折断。1280×800 原生启动页使用实际 launcher.js 与 IPC stub，两个入口都接到正确 mode。所有截图已亲看，控制台无 pageerror。

截图和 JSON 记录在本工作树 `game/test-results/cover-review/`，主要文件为 `public-1440x900.png`、`public-rooms-844x390.png`、`public-390x844.png`、`native-1280x800.png` 与 `report.json`。公共大厅 fixture 取自公共大厅 lane 的实际 HTML/CSS，复用本切片真实 CSS/资产；这次视觉测试不代替最终集成树的真实大厅协议和安装包验收。

封面与图标统一使用无人物几何校园图形。`cover.css` 的 `--cover-warden` 保留兼容字段名并指向 `warden-cover-cartoon-v2.webp`；打包脚本由此生成 PNG、ICO、ICNS 与 Android adaptive 图标，不依赖照片、人物外貌参考或旧生成提示词。

封面和应用图标使用同一虚构校园几何主题；进入应用或网页后的开始界面保留代码绘制的绿色粉笔黑板。共享 `cover.css` 与原生启动页 `chalk.css` 的兼容接线不变。
