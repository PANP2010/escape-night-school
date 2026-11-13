# 手机地图与 HUD 遮挡切片交接

本树：`/private/tmp/escape-sprint-mobile_hud`，基于已 review 的 v040 集成提交；保留中断前 WIP 后继续完成。未改 `game.ts`、`touch.ts`、`input.ts`、`worldTouch.ts`、todo、loop、凭据或共享依赖。

## 产品变化

- 手机地图标题与两个操作按钮分行，按钮至少 44×44 px；短横屏为画布、标题、图例预留高度，画布等比显示。
- 打开地图时收起下面的教程、操作说明与目标箭头，将交互提示放到左侧空白栏；左上房间码按安全区向内收。
- 地图保留触摸穿透。面板增加实底，字幕/箭头切换提示不会透进地图文字。
- 底部引导箭头为操作说明及 home indicator 预留空间；增加静态描边和距离字底色，不恢复昂贵的逐帧滤镜。
- 出口标签只参考当前楼层的相邻走廊，避免另一层走廊把标签拉向封路叉号。
- 安全区下的底部说明按屏幕左缘定位、左右留白，避免 HUD padding 导致横向偏移。

## 关联文件及合并注意

产品文件为 `game/client/src/map.ts`、`guide.ts` 和 `style.css` 中地图/箭头/操作说明小段。保留集成基线 `game.ts:sizeMap()` 已有的摇杆/右侧操作区避让，不整文件替换。

新增 `game/playwright.mobile-hud.config.ts` 使用固定 4418 端口、Metal、静音；`game/tests/e2e/x-map-layout.spec.ts` 复用同一浏览器，顺序创建桌面/手机 context。支持集成代理的全量测试配置。

## 验证

- 设计文档 94 行、主待办 596 行已完整分段阅读；本树及祖先目录未发现适用 AGENTS.md。
- 经 `parallel_sprint.py gate heavy`：typecheck 通过；map/guide/guide_campus/hud_layout 84 项通过，L4 map 13 项通过；客户端构建通过。
- 最终代码经 `gate browser` 验收：1 passed（45.9 s）；14 组 L1/L2 布局覆盖 1280×720、844×390、667×375、390×844、旋转恢复、左右 44/底部 34 px 安全区。结果为 `reports=14`、`errors=[]`，开图时无操作说明透出。
- 最终截图已亲自查看：地图底色、按钮及画布完整，地图下不再露出半截说明；底部箭头与操作说明分开，竖屏遮罩及旋转恢复正常。4418 测试服务器已退出。

证据在本树 `game/test-results/mobile-hud-*.png`、`mobile-hud-final.json`、`mobile-hud-e2e.log`。生成产物与证据不提交。

## 剩余边界

竖屏继续显示现有“请横屏游玩”遮罩，旋回横屏恢复地图。测试为 Chromium/Metal 触屏模拟，未做真实 iOS Safari 或视频外部评分。全量 check 和部署由集成代理串行完成；本 lane 不发布。
