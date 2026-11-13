# 原生客户端下载

`server/downloads.ts` 导出 `handleDownloads(req, res, url, directory): boolean`。在 HTTP 静态文件路由前调用：

```ts
if (handleDownloads(req, res, url, resolve(process.env.DOWNLOADS_DIR ?? '../downloads'))) return;
```

独立目录存放现有 `release-manifest.json`、其 `artifacts` 中的安装包、`README.zh-CN.md`、`SHA256SUMS.txt` 与可选验收 JSON。页面 `/downloads/` 直接读取现有清单，列出架构、大小和 SHA-256；`/downloads/manifest.json` 是原始清单的别名。安装器支持 GET / HEAD、单个字节范围及 ETag，流式读取；只开放清单安装包和固定说明文件，拒绝路径穿越、目录及指向目录外的符号链接。未列出的文件不公开。

发布前可执行：

```sh
node scripts/verify-downloads.ts /absolute/path/to/releases/0.5.0 --output test-results/downloads-0.5.0-integrity.json
```

2026-11-07 已重新读取 `/Users/local-user/escape/releases/0.5.0`：7 份成品的实际大小与 SHA-256 全部匹配 `release-manifest.json`；`shasum -a 256 -c SHA256SUMS.txt` 的全部记录通过。校验为只读，不改安装包及原验收文件。0.5.0 原清单仍标记 `integrationState: pending`；页面据实注明，未将历史 Mac 验证误写为新候选包的实机验证。

现有构建器位于 `apps/package.json` 与 `apps/desktop/builder.cjs`：`npm run prepare:game -- --game <游戏目录>` 准备客户端与服务器；`npm run desktop:mac` 生成双架构 DMG，`npm run desktop:win` 生成 Windows x64 / ARM64 NSIS。Android 构建源位于 `apps/android`，内置 WebView 客户端，连接指定云端或局域网的 `/ws`。0.5.0 桌面内置服务仅绑定 127.0.0.1；后续 0.6.0 使用专用局域网开房入口，下载页按清单版本显示对应说明。

验证：`npm run typecheck`，`npx vitest run tests/unit/downloads.test.ts`，5 项真实 HTTP 测试覆盖完整字节、HEAD、Range、ETag、页面、名单和路径限制。
