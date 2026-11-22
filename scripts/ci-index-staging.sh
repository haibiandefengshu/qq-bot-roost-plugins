#!/usr/bin/env bash
# CI 索引准备
# ===========
#
# 投稿约定（2026-11-22 起）：作者交 `plugins/<id>/` + 由 build-index.mjs
# 生成的根 `index.json`。index.json 像 lockfile——由脚本产出，但随 PR 提交，
# CI 校验它没被手改歪。
#
# 因此 PR 事件**不再用临时副本兜绿**：
#   - fork PR 改了 plugins/ 就必须同时改 index.json；
#   - index.json 必须和插件目录逐字段对得上（build-index.mjs --check）；
#   - 维护者字段是否被伪造，由 check-index-submission.mjs 另查。
#
# push 到 main 仍保留临时重建：给「旧规 PR 合入 → 维护者补索引」的窗口
# 留一个 warning，不让主分支短暂漂移变红。workflow_dispatch 严格失败。
#
# 输入环境变量：
#   CI_BASE_REF      基准 ref（PR 用 origin/<base>，push 用 before）
#   GITHUB_EVENT_NAME pull_request / push / workflow_dispatch
#   GITHUB_EVENT_PATH 事件 JSON（用来判断是否 fork PR）
#   GITHUB_ENV        Actions 环境文件（写回 CI_INDEX_DIR / CI_INDEX_STAGED）
#   RUNNER_TEMP       临时目录父级
# 输出环境变量：
#   CI_INDEX_DIR      本轮索引相关检查应使用的目录
#   CI_INDEX_STAGED   1 = 用了临时索引，0 = 用仓库正式索引

set -euo pipefail

base="${CI_BASE_REF:-}"
if [ -z "$base" ]; then
  echo "::error::CI_BASE_REF 未设置，无法确定比较基准"
  exit 1
fi

is_fork=false
if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] \
  && [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
  is_fork=$(node -e '
    try {
      const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const head = e.pull_request?.head?.repo?.full_name || "";
      const base = e.repository?.full_name || "";
      process.stdout.write(head && head !== base ? "true" : "false");
    } catch { process.stdout.write("false"); }
  ' "$GITHUB_EVENT_PATH")
fi

# 1) fork 投稿：plugins/ 与 index.json 必须成对改动
if [ "$is_fork" = "true" ]; then
  plugin_touched=$(git diff --name-only "$base"...HEAD -- plugins/ || true)
  index_touched=$(git diff --name-only "$base"...HEAD -- index.json || true)
  if [ -n "$plugin_touched" ] && [ -z "$index_touched" ]; then
    echo "::error::投稿改了 plugins/ 但没提交 index.json。"
    echo "::error::请先跑 node scripts/build-index.mjs，把生成结果一起提交。"
    exit 1
  fi
  if [ -z "$plugin_touched" ] && [ -n "$index_touched" ]; then
    echo "::error::投稿只改了 index.json，但没有对应的 plugins/ 改动。"
    echo "::error::索引是插件目录的投影，请提交插件内容或用生成器重建后核对差异。"
    exit 1
  fi
fi

# 2) 正式索引一致：所有事件都直接用原目录
if node scripts/build-index.mjs --check >/dev/null 2>&1; then
  echo "CI_INDEX_DIR=$PWD" >> "$GITHUB_ENV"
  echo "CI_INDEX_STAGED=0" >> "$GITHUB_ENV"
  echo "✓ 索引已一致，使用仓库正式索引"
  exit 0
fi

# 3) 漂移处理：PR 严格失败；push 给临时重建 warning；手动触发严格失败
case "${GITHUB_EVENT_NAME:-}" in
  pull_request)
    echo "::error::index.json 与 plugins/ 不一致，请跑 node scripts/build-index.mjs 并提交生成结果。"
    node scripts/build-index.mjs --check || true
    exit 1
    ;;
  push) ;;
  *)
    echo "::error::索引与插件目录不一致。workflow_dispatch 不启用临时索引，请先重建索引。"
    exit 1
    ;;
esac

stage="${RUNNER_TEMP:-/tmp}/ci-index-staging"
rm -rf "$stage"
mkdir -p "$stage"
tar --exclude=.git -cf - . | tar -xf - -C "$stage"

cd "$stage"
node scripts/build-index.mjs
node scripts/build-index.mjs --check

echo "CI_INDEX_DIR=$stage" >> "$GITHUB_ENV"
echo "CI_INDEX_STAGED=1" >> "$GITHUB_ENV"
echo "::warning::main 上索引短暂漂移（旧规 PR 合入或人工漏重建）。已用临时重建索引复核；请尽快提 PR 提交 node scripts/build-index.mjs 的结果。"
