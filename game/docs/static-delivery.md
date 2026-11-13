# Compressed static delivery

`npm run build:client` runs `scripts/precompress.ts` after Vite. It writes gzip
(level 9) and Brotli (quality 9) siblings for text assets of at least 512 bytes,
only when the result is smaller. Files are processed sequentially. Runtime
deployments must copy the complete `dist/` directory, including `.gz`/`.br` files.

The HTTP server streams a fresh sidecar when `Accept-Encoding` allows it. It
honors q values, identity exclusions and wildcards; equal preferences choose
Brotli, then gzip. An absent or empty header returns the original file. Missing
or older sidecars fall back to identity when allowed, otherwise return 406.
No request performs compression or adds asset bytes to a persistent cache.

Encoded responses use the original MIME type, selected file size and
`Vary: Accept-Encoding`. HEAD has the same headers without opening a body stream.
`version.json` remains `no-store`, HTML remains `no-cache`, and hashed assets
remain immutable. Health and WebSocket routes retain their own behavior.

Validation on 2026-11-05, master `fb7e154`, Node 26.13.0, local loopback:

| Main JavaScript | Bytes | First TTFB | Mean warm TTFB (10) |
| --- | ---: | ---: | ---: |
| identity | 1,371,320 | 4.37 ms | 0.50 ms |
| gzip | 420,732 | 0.37 ms | 0.24 ms |
| Brotli | 379,235 | 0.23 ms | 0.35 ms |

This removes 69.3% / 72.3% of JavaScript transfer bytes. Building all sidecars
took 119 ms. First means the first request for that encoding in a new process;
the OS disk cache was not flushed. These measurements do not establish public
network latency or download speed. The existing public observation was an
uncompressed transfer at approximately 17 KB/s; public improvement needs a
post-deploy measurement.

Real HTTP tests cover exact decompressed bytes, encoding preferences and
rejections, stale sidecars, content headers, HEAD, cache rules, bad paths,
unreadable file streams, health and a production WebSocket welcome. Chromium
loaded JavaScript and CSS as Brotli, created and started a room, received 17
snapshots, and reported no page errors. SHA-256 after decompression matched the
original JavaScript for all measured requests. Release checks should hash
decoded bytes (`fetch` decodes automatically; use `curl --compressed` for curl),
and check encoded transfer size separately.

Raw local benchmark evidence and a reviewed browser screenshot are in
`/private/tmp/escape-delivery-speed-evidence/`. A separate process consumed 1,000
alternating gzip/Brotli responses: RSS was 84.9 MB at startup, 118.2 MB after 100,
125.5 MB after 500, and 138.1 MB after 1,000. This includes Node allocation and GC
behavior; it is not a heap leak proof or a per-connection memory bound. Asset
data is streamed with backpressure and discarded, with no application cache.

Run the focused regression with:

```
npx vitest run tests/unit/static_delivery.test.ts --maxWorkers=2
```

It builds an isolated server fixture from source and uses port 4385. Full
`npm run build` and `npm run typecheck` were also successful. No cloud server or
network topology was changed during this validation.
