# deps —— 外接依赖的备选下载源

框架的「外接 → 依赖」卡要装 `ws` 和 `silk-wasm`。正常情况下走 npm，
但 npm 这条路会坏：用户机器上根本没装 npm、公司网拦了 registry、
源超时到 180 秒、装完 `require` 起来还是报错。这时框架按
`index.json` 的 `deps` 字段回到这个目录取包，**直接解包、不经过 npm**。

## 目录里只有一个清单和几个 tgz

```
deps/
  manifest.json          名字 / 版本 / 许可 / 文件名（人改）
  ws-8.23.0.tgz          npm 原包，未改动
  silk-wasm-3.7.1.tgz
```

`index.json` 里的 `deps` 数组由 `scripts/build-index.mjs` 扫描本目录生成，
带 `sha256` 和 `size`。**不要手改 `index.json` 那一段**，下次生成就覆盖了。

## 为什么只有这两个包

| 包 | tgz 体积 | 依赖树 | 许可 |
|---|---|---|---|
| `ws` | 36 KB | 无 | MIT |
| `silk-wasm` | 105 KB | 无 | MIT |

两个都是**零依赖**，解包到 `node_modules/<名字>/` 就能直接 `require`，
不需要解决依赖树——这是能"不经过 npm"的前提。

**`@ffmpeg-installer/ffmpeg` 不放这里**，三个理由：

1. 它挂着 8 个平台子包（darwin-arm64/x64、linux-arm/arm64/ia32/x64、
   win32-ia32/x64），每个都是静态二进制，全平台上百 MB；
2. GitHub 单文件上限 100 MB、Gitee 是整仓镜像，拖累每一次 clone 和同步；
3. 它是 GPL/LGPL 系，自己再分发要连带许可证与源码获取方式，合规负担不划算。

所以 ffmpeg 仍然走 npm，或者用系统里已有的那份。

## 怎么刷新

1. 从 npm 官方源下新包，**核对 `dist.integrity`**（sha512），别用第三方镜像的包；
2. 改 `manifest.json` 里的 `version` / `file`；
3. `node scripts/build-index.mjs`；
4. `node scripts/build-index.mjs --check` 必须过。

框架侧的白名单写的是版本范围（`ws: ^8.18.0`、`silk-wasm: ^3.7.1`），
本地包版本落在范围外会被**跳过**，不会硬装旧版。所以这里放旧版不会造成
"永远装不上"，只会让这台机器退回 npm。

## 许可

两个包都是 MIT，tgz 里自带 `package/LICENSE` 与 `package/package.json`，
解包后原地保留，不删不改。
