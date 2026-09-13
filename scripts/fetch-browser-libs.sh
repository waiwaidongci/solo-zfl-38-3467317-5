#!/usr/bin/env bash
# 在没有 root / sudo 的环境里，为 Playwright 的 chromium 准备系统依赖库：
# 用 apt-get download（无需 root）把 .deb 下载并解包到本地目录，
# Playwright 启动测试时（test/e2e/browser.js）会自动把这些目录加入 LD_LIBRARY_PATH。
# 已有 root 的环境直接执行 `npx playwright install --with-deps chromium` 即可，无需本脚本。
set -euo pipefail

DEB_DIR="${DEB_DIR:-/tmp/chromedebs}"
LIB_DIR="${CHROME_LIBS:-/tmp/chromelibs}"
LIST_DIR="$(mktemp -d)/lists"
CACHE_DIR="$(mktemp -d)/cache"
mkdir -p "$DEB_DIR" "$LIB_DIR" "$LIST_DIR/partial" "$CACHE_DIR/archives/partial"

PACKAGES=(
  libnspr4 libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1
  libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2
  libasound2 libatspi2.0-0 libxi6 libwayland-server0
)

apt-get -o Dir::State::Lists="$LIST_DIR" -o Dir::Cache="$CACHE_DIR" update >/dev/null

cd "$DEB_DIR"
apt-get -o Dir::State::Lists="$LIST_DIR" -o Dir::Cache="$CACHE_DIR" download "${PACKAGES[@]}" >/dev/null
for f in *.deb; do dpkg-deb -x "$f" "$LIB_DIR"; done

echo "依赖库已解包到 $LIB_DIR（E2E 测试会自动加载）"
