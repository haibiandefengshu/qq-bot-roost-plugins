# 栖 Roost 插件仓库

> 提交你的插件，用户在面板「插件 → 市场」里一键安装。

- 主程序：[qq-bot-roost](https://github.com/roost-qq/qq-bot-roost)
- 插件清单：[`index.json`](index.json)

---

## 怎么提交插件（贡献者）

1. Fork 本仓库
2. 把你的插件放进 `plugins/<插件id>/`（要求见下面「插件目录要求」）
3. 本地自检并生成索引：

   ```bash
   node --check plugins/<id>/index.js                    # 语法
   node scripts/check-versions.mjs --base origin/main    # 改了内容必须升 version
   git grep -Il $'\r' -- 'plugins/**'                    # 不能有 CRLF
   node scripts/build-index.mjs                          # 生成根 index.json
   node scripts/build-index.mjs --check                  # 确认索引一致
   ```

4. 提交 **`plugins/<插件id>/` + 根 `index.json`**，提 PR

> ⚠️ `index.json` 要随 PR 提交，但**不要手改字段**：它和 `package-lock.json`
> 一样由脚本生成。CI 会复算并比对，手改 `verified` / `category` / `repo` /
> 署名等维护者字段会被拦下。

`index.json` 像 lockfile：内容由 `build-index.mjs` 从插件目录算出来，随投稿
一起进仓库，用户刷新面板的插件市场就能看到并安装，不用等合并后再 bot 回写。
投稿 PR 只被允许改 `plugins/**` 与根 `index.json`；其余文件由维护者维护。

---

## 索引与内容完整性

插件市场要回答一个具体问题：**用户下载到的插件，是不是仓库里那一份**。
靠的是 `index.json` 里每个插件的 `sha256`：

```
index.json 的 sha256  ──►  用户下载插件目录  ──►  本地重算 sha256  ──►  比对
对不上 = 内容被改过（或换行符被转换过）→ 拒绝安装
```

`index.json` 由 `build-index.mjs` 从 `plugins/*/` 重算生成，随投稿 PR 提交；
合并后 `sync-artifacts.yml` 只校验、不回写。安装时的 sha256 校验保证
「装到的是索引记载的那份」，索引本身的权威来自仓库提交历史，不再来自签名。
投稿风险由 `pr-guard.yml` 拦路径/凭证、由 CI 复算索引与维护者字段，
最后仍由维护者人工审；`main` 保留禁强推 / 禁删除。

> 2026-11-11 起插件索引不再签名（原 `index.json.sig` / `trust-public.pem` /
> 手动签名 workflow 均已移除）。原因是个人仓无法给 GitHub Actions 配 bypass，
> 签名与机器人回推只能二选一。2026-11-22 起改为投稿 PR 自带生成器产出的
> `index.json`，bot 不再回写 main；分支保留四项必需检查，投稿门禁由
> `pr-guard.yml` + `ci.yml` + 人工审共同把关。
> **框架自更新的 `SHA256SUMS.sig` 签名不受影响，照旧保留。**

---

## 索引是投稿的一部分（生成器产出，CI 校验）

`index.json` 由 `build-index.mjs` 生成，随 PR 提交。CI 会做三层校验：

1. `build-index.mjs --check`：结构字段（`id` / `version` / `path` / `sha256` /
   `runtime` / `kind` / `scopes` / `overrides` / `form` / `frameworkVersion`）、
   `verified`、`category` 必须与磁盘和分级表一致；
2. `check-index-submission.mjs`：顶层 `schema` / `repo` / `branch` 不能改，
   `contributors` / `credits` / `addedAt` 等维护者字段不能伪造；
3. `pr-guard.yml`：投稿路径白名单只放 `plugins/**` 与根 `index.json`。

本地生成 / 校验：

```bash
node scripts/build-index.mjs
node scripts/build-index.mjs --check
node scripts/check-index-submission.mjs   # 非 fork PR 会跳过
```

`build-index.mjs` 的合并规则：结构字段以磁盘为准，展示字段
（`name` / `description` / `tags` / `commands` / `author`）保留已有内容——
所以反复跑结果一致，不会把别人写过的文案冲掉。新插件自动补一条，
删掉的插件自动移除。

`author` 只保留 GitHub 用户名，作为市场搜索用的展示提示
（新条目取 `plugin.json.author`，存量条目沿用原值），**不是署名依据**。
贡献归属看 GitHub Contributors 与各 PR 记录。`credits` / `addedAt` /
`contributors` 这些旧流程字段已从索引退役：投稿人不能新增，存量值也已清理。

`version` 要写成字面量（`version: '1.2.3'`）。写成常量的话，
`check-versions.mjs` 和本脚本都读不到——CI 会直接判「读不到 version」。

**改任何插件内容都必须升 `version`**（`index.js` 和 `package.json` 两处）。
市场只比版本号，不升版老用户永远收不到更新。

---

## 维护者发版完整流程

> 每一步后面都写了**漏掉的后果**，都是真踩过的。

### 0. 前置检查

确认在 `main` 的最新提交上、工作区干净：

```bash
git status --short
```

### 1. 收 PR / 放插件

贡献者的 PR 含 `plugins/<id>/**` + 根 `index.json`。**不要直接点 GitHub 的合并按钮**，拉到本地：

```bash
node scripts/merge-pr.mjs 2             # 拉分支 + 校正提交身份 + merge
node scripts/merge-pr.mjs 2 --dry-run   # 只演一遍，不动仓库
```

脚本会把每个提交的 author / committer 校正成 **PR 发起人**的 GitHub 身份
（`<id>+<login>@users.noreply.github.com`）。这不是为了好看：GitHub 的 Contributors
按 commit 的 **author 邮箱**归户，贡献者在自己机器上带着别人的 `user.email` 提交时，
这次贡献会记到邮箱主人头上，作者本人在仓库里一次提交都没有。

PR 现在**必须**带 `index.json`，脚本不再因它中止；字段由 CI 复算校验。

没有 PR、只是拿到一个目录时才手工放：

```bash
git checkout FETCH_HEAD -- plugins/<id>
# 然后生成索引
node scripts/build-index.mjs
```

取插件目录后要补一份生成器产出的 `index.json`。

然后过一遍：

```bash
node --check plugins/<id>/index.js                     # 语法
git grep -Il $'\r' -- 'plugins/**'                     # 不能有 CRLF
grep -rn "eval(\|new Function\|child_process" plugins/<id>/*.js   # 跑外部命令的要人工看
```

提交前本地先跑 `node scripts/build-index.mjs --check` 确认索引一致（CI 跑的就是这条）；
索引作为生成物随 PR 提交，合并后 `sync-artifacts.yml` 只校验、不回写
（见上面「索引是投稿的一部分」）。

### 2. 开分支、提交

```bash
git switch -c feat/<插件id>-<版本>    # 或 fix/<词>
git add plugins/<id> index.json
git commit -m "feat(plugins): 收录 <id> <version>"
```

提交插件目录与生成器产出的 `index.json`，**不提交 README**——贡献者表已删除，
README 是纯手写文档。

### 3. 推分支、开 PR

```bash
git push -u origin HEAD
gh pr create --fill                   # 或到 GitHub 网页开
```

走 PR 而不是直推 `main`：**维护者自己的插件改动也一样，要开 PR 再合并**。
直推会绕过 `pr-guard.yml` 的路径拦截和 CI 四项必需检查。本仓 PR 没有强制人工审核，
**CI 结论 + 维护者看 diff 就是代码门禁**，别自己拆。

### 4. Gitee 不用管

Gitee 由**原生 Pull 镜像**自动同步 GitHub 的提交（2026-11-17 起），不要再手动推。
以前那种「历史分叉就造同树提交、`git push gitee`」的做法已废弃；同步滞后几分钟是正常的，
不该也不需要人工干预。

### 5. 等 CI

CI 的三个 job 都要绿：`check`（语法 / 版本号 / 索引一致 / 投稿字段校验）、
`test`（插件测试）、`eol`（换行符）。索引不一致在 PR 里直接红并提示重跑
`build-index.mjs`；不再用临时副本兜绿。fork 投稿还会另跑 `pr-guard.yml` 的
路径 / 凭证 / 符号链接拦截。

`test` job 会把框架 checkout 到 `.framework/`，ref 由 `.github/workflows/ci.yml`
的 `FRAMEWORK_REF`（或仓库 Variables）决定。**发框架新版时要同步改这个 ref**，
否则插件测试跑在旧框架上，可能假绿也可能假红。

### 6. 合并后核对索引

投稿已随 PR 带上 `index.json`，合并后 `sync-artifacts.yml` 只做一致性校验。
确认 GitHub Actions 里「Sync artifacts from merge」是绿的即可；若出现漂移 warning，
说明有人漏了重建索引，从最新 `main` 跑一次 `node scripts/build-index.mjs` 并开 PR 提交。
贡献归属不用查索引：GitHub Contributors 按 commit author 归户，PR 记录保留完整讨论。
Gitee 由镜像自动同步，不用核。

---

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| CI「索引和插件目录对不上」 | 投稿没提交生成器产出的 `index.json`，或手改了字段 | 跑 `node scripts/build-index.mjs` 并提交结果 |
| CI「投稿索引校验失败」 | 改了 `repo` / 署名 / 分级等维护者字段 | 用生成器重建，不要手填这些字段 |
| 合并后 sync 报索引漂移 warning | 旧规 PR 合入或人工漏重建 | 从最新 main 重建索引并开 PR 提交 |
| CI「以下文件含 CRLF」 | Windows 检出被转成 CRLF，sha256 就对不上 | `.gitattributes` 已有 `* text=auto eol=lf`；用 `git add --renormalize .` 重新规范化 |
| 用户装不上，报 sha256 不符 | 索引哈希和实际目录不一致 | 重建索引，确认提交的是 LF |
| CI「读不到 version」 | `version` 写成了常量 | 改成字面量字符串 |
| 插件测试假红/假绿 | `FRAMEWORK_REF` 钉在旧框架 tag | 改 `ci.yml` 里的 ref，或设仓库 Variables |

---

## 插件目录要求

```
plugins/<插件id>/
├── index.js          ← 内建插件（JS），或者：
├── plugin.json       ← 外部插件清单
└── main.py           ← 外部插件入口
```

**二选一**：有 `index.js` 就是内建插件（跑在主进程），有 `plugin.json` 就是外部插件（子进程）。

写之前请先读主程序的 [插件开发规范](https://github.com/roost-qq/qq-bot-roost/blob/master/docs/插件开发规范.md)
和 [插件协议](https://github.com/roost-qq/qq-bot-roost/blob/master/docs/插件协议.md)。

### 硬性要求

| 要求 | 说明 |
|------|------|
| `id` 全局唯一 | 命令名也是全局唯一的，别用 `help` / `status` 这类通用词 |
| 必须提供菜单 | `ctx.menu(...)` 或 `plugin.json` 的 `menus`，否则用户看不到怎么玩 |
| 零依赖优先 | 内建插件只能用 Node 内置能力；外部插件可以在 `plugin.json` 里声明依赖 |
| 不写死凭证 | 不要在自己的代码里塞 AppSecret 或 token |
| 数据存 `dataDir` | 外部插件用 `init` 下发的 `dataDir`；内建插件用 `ctx.storage` |
| 不要跨机器人读数据 | 数据是按机器人隔离的，`openid` 也不通用 |

---

## `index.json` 条目格式

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说清它能干什么",
  "author": "你的 GitHub 用户名",
  "path": "plugins/my-plugin",
  "runtime": "node",
  "tags": ["工具"],
  "commands": ["mycmd"]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 与目录名一致，小写字母数字短横线 |
| `name` | ✅ | 显示名 |
| `version` | ✅ | 语义化版本 |
| `description` | ✅ | 一句话，别超过 60 字 |
| `author` | ✅ | 你的 GitHub 用户名 |
| `path` | ✅ | 相对仓库根目录的路径 |
| `runtime` | ✅ | 外部插件的启动方式：`python` / `node` / `go` / `exec`。内建插件（`index.js`）没有 `plugin.json`，也就没有这个字段 |
| `tags` | | 分类标签 |
| `commands` | | 主要命令名，方便用户检索 |

> `credits` / `addedAt` / `contributors` 是已退役的旧流程字段，投稿人不要填；
> 它们只作为维护者字段在校验脚本里保留识别，索引里不再出现。

---

## 收录标准

会被拒绝的情况：

- 需要用户自己改代码才能跑起来的
- 内置了广告、引流、未经声明的收费引导的
- 会读取或上传用户凭证的
- 明显抄袭别人的插件
- 恶意刷屏、无冷却的大量发消息

---

## 贡献者

这里的插件来自社区投稿，谢谢这些作者。收录时保留原来的代码，只重建索引——代码长什么样，就是作者写成什么样。

贡献归属以 [GitHub Contributors](https://github.com/roost-qq/qq-bot-roost-plugins/graphs/contributors)
和各 PR 记录为准；README 不再维护贡献者表，也不在索引里维护署名。
`index.json` 里的 `author` 只是市场搜索用的展示提示，不代表署名。

也想放一个进来？见上面「[怎么提交插件](#怎么提交插件贡献者)」。

---

## 💬 交流群

写插件、投稿、用市场装插件遇到问题，都欢迎来聊。提问时尽量带上插件 id、版本号和相关日志。

群号：**1130901545**

<div align="center">
<img src="docs/images/qq-group.jpg" alt="roost 交流群二维码" width="240" />
</div>

---

## 许可

**默认**：插件沿用本仓库的 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**——允许商业使用与收费分发，但分发或通过网络提供服务时必须同样开源并提供对应源码。见 [LICENSE](LICENSE)。提交 PR 即表示你同意你的插件按此默认许可发布。

**自定义**：插件作者可以在自己的插件目录里放一份 `LICENSE`（或 `LICENSE.md` / `COPYING` 等），以此声明本插件采用别的开源协议。这不是强制项：不放 `LICENSE` 就默认跟随上面的 AGPL-3.0-only，不用额外声明。放了的话，请在插件 README 的「许可」段写一句「本插件采用 XXX，见 [LICENSE](LICENSE)」，让读者一眼能看到。

- 协议文件与 README 属于文档声明，**不进插件内容指纹**（`sha256` 只覆盖代码与素材），所以改协议、改文案不用升 `version`。
- 引用第三方代码时，第三方许可照旧在插件 README 里说明；那不影响本插件自身的许可选择。
- `plugins/jm-comic/`、`plugins/pixiv-pid/` 是第三方投稿，保留各自 README 中声明的原许可（免费、禁止收费转售与商业分发），不套用默认 AGPL。
