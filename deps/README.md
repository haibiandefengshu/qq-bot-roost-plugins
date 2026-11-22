# deps —— 依赖的备选下载源

宿主的「依赖 / 功能包」卡要装 `ws`、`silk-wasm`、`qrcode`。正常情况下走 npm，
但 npm 这条路会坏：用户机器上根本没装 npm、公司网拦了 registry、
源超时到 180 秒、装完 `require` 起来还是报错。这时宿主按
`index.json` 的 `deps` 字段回到这个目录取包，**直接解包、不经过 npm**。

## 目录结构

```
deps/
  manifest.json          名字 / 版本 / 许可 / 文件名（人改；bundle 由脚本生成）
  ws-8.23.0.tgz          零依赖单包，npm 原包未改动
  silk-wasm-3.7.1.tgz
  qrcode/                bundle：带传递依赖的整棵树
                         （清单在上面 manifest.json 的 bundles 段）
    qrcode-1.5.4.tgz
    yargs-15.4.1.tgz
    …共 29 个包
```

`index.json` 里的 `deps` 数组由 `scripts/build-index.mjs` 扫描本目录生成，
带 `sha256` 和 `size`。**不要手改 `index.json` 那一段**，下次生成就覆盖了。

## 两种条目

| 形态 | 索引里长什么样 | 装法 |
|---|---|---|
| 单包 `packages` | `{ name, version, path, sha256, size }` | 解一个 tarball 到 `node_modules/<name>/` |
| 多包 `bundles` | `{ name, version, kind:"bundle", packages:[…] }` | 逐个解包，**平铺**进同一个 `node_modules/` |

两个零依赖包用单包形态；`qrcode` 有 3 个直接依赖、整棵树 29 个包，必须平铺
（那就是 npm 的 hoisted 布局），所以用 bundle。

## 为什么只有这几个包

| 包 | 体积 | 依赖树 | 许可 |
|---|---|---|---|
| `ws` | 36 KB | 无 | MIT |
| `silk-wasm` | 105 KB | 无 | MIT |
| `qrcode` | 402 KB（29 个包） | 有，全纯 JS | MIT / ISC |

前两个是**零依赖**，一个 tarball 就能用；`qrcode` 整棵树都是纯 JS、无安装脚本，
平铺进去就能 `require`。

**`@ffmpeg-installer/ffmpeg` 不放这里**，三个理由：

1. 它挂着 8 个平台子包（darwin-arm64/x64、linux-arm/arm64/ia32/x64、
   win32-ia32/x64），每个都是静态二进制，全平台上百 MB；
2. GitHub 单文件上限 100 MB、Gitee 是整仓镜像，拖累每一次 clone 和同步；
3. 它是 GPL/LGPL 系，自己再分发要连带许可证与源码获取方式，合规负担不划算。

所以 ffmpeg 仍然走 npm，或者用系统里已有的那份（宿主面板会提示）。

## 怎么刷新

**单包**（零依赖）：

1. 从 npm 官方源下新包，**核对 `dist.integrity`**（sha512），别用第三方镜像的包；
2. 改 `manifest.json` 里的 `version` / `file`；
3. `node scripts/build-index.mjs`；
4. `node scripts/build-index.mjs --check` 必须过。

**bundle**（带依赖树）：

```bash
node scripts/pack-bundle.mjs qrcode@1.5.4 --why "生成二维码（扫码登录）"
node scripts/build-index.mjs
```

脚本会：用 npm 的 `--package-lock-only` 锁定精确版本 → 逐个下载并核对 lock 里的
`integrity` → 清掉目录里旧的 tgz → 写回 `deps/manifest.json` 的 `bundles` 条目。
**别手抄版本和文件名**，29 个包手抄一次就会错一个。

宿主侧的白名单写的是版本范围（`ws: ^8.18.0`、`silk-wasm: ^3.7.1`、
`qrcode: ^1.5.4`），本地包版本落在范围外会被**跳过**，不会硬装旧版。所以这里
放旧版不会造成"永远装不上"，只会让这台机器退回 npm。

## 许可

三个包都是 MIT（`qrcode` 树里的 `cliui` / `y18n` 等少数子包是 ISC），
tgz 里自带 `package/LICENSE` 与 `package/package.json`，解包后原地保留，不删不改。

