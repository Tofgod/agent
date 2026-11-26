#!/bin/sh
set -eu

CDPATH= cd -P "$(dirname "$0")"

fail() {
  printf 'do漫：%s\n' "$*" >&2
  exit 1
}

setup=false
if [ "${1:-}" = --setup ]; then
  setup=true
  shift
fi
[ "$#" -eq 0 ] || fail "请运行 sh start.sh，首次使用请运行 sh setup.sh。"
[ -f package.json ] && [ -f package-lock.json ] && [ -d drizzle ] ||
  fail "请完整解压项目，并在 package.json 所在目录运行脚本。"

platform="$(uname -s)"
case "$platform" in
  Darwin|Linux) ;;
  *) fail "请在 macOS、Linux 或 Windows 的 WSL 里运行此脚本。" ;;
esac

linux_arch=
node_dir=
if [ "$platform" = Linux ]; then
  case "$(uname -m)" in
    x86_64) linux_arch=x64 ;;
    aarch64|arm64) linux_arch=arm64 ;;
  esac
  if [ -n "$linux_arch" ]; then
    node_dir="$PWD/.studio-runtime/node-linux-$linux_arch"
  fi
fi

node_ready() {
  command -v npm >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || major === 24 && minor >= 9 ? 0 : 1)' >/dev/null 2>&1
}

media_ready() (
  ffmpeg="${FFMPEG_PATH:-ffmpeg}"
  ffprobe="${FFPROBE_PATH:-ffprobe}"
  "$ffprobe" -version >/dev/null 2>&1 || exit 1
  filters="$("$ffmpeg" -hide_banner -filters 2>/dev/null)" || exit 1
  printf '%s\n' "$filters" | awk '$2 == "subtitles" { found=1 } END { exit !found }' || exit 1
  encoders="$("$ffmpeg" -hide_banner -encoders 2>/dev/null)" || exit 1
  printf '%s\n' "$encoders" | awk '$2 == "libx264" { h264=1 } $2 == "aac" { aac=1 } END { exit !(h264 && aac) }'
)

brew_bin=
find_brew() {
  brew_bin="$(command -v brew || true)"
  if [ -z "$brew_bin" ] && [ -x /opt/homebrew/bin/brew ]; then brew_bin=/opt/homebrew/bin/brew; fi
  if [ -z "$brew_bin" ] && [ -x /usr/local/bin/brew ]; then brew_bin=/usr/local/bin/brew; fi
  [ -n "$brew_bin" ]
}

load_tools() {
  if [ "$platform" = Darwin ] && find_brew; then
    brew_prefix="$("$brew_bin" --prefix)"
    export PATH="$PATH:$brew_prefix/bin"
    if ! node_ready && [ -x "$brew_prefix/opt/node@24/bin/node" ]; then
      export PATH="$brew_prefix/opt/node@24/bin:$PATH"
    fi
    if ! media_ready && [ -x "$brew_prefix/opt/ffmpeg-full/bin/ffmpeg" ]; then
      export PATH="$brew_prefix/opt/ffmpeg-full/bin:$PATH"
    fi
  elif [ -n "$node_dir" ] && [ -x "$node_dir/bin/node" ] && ! node_ready; then
    export PATH="$node_dir/bin:$PATH"
  fi
}

download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --retry 2 "$@"
}

install_homebrew() (
  installer="$(mktemp -t doman-homebrew)"
  trap 'rm -f -- "$installer"' 0
  printf '正在准备 Homebrew。安装器可能要求确认或输入系统密码。\n'
  download -o "$installer" https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh
  /bin/bash "$installer"
)

install_linux_node() (
  mkdir -p .studio-runtime
  staging="$(mktemp -d "$PWD/.studio-runtime/node-install.XXXXXX")"
  trap 'rm -rf -- "$staging"' 0
  printf '正在下载 Node.js 24 到项目本地目录。\n'
  release=https://nodejs.org/dist/latest-v24.x
  download -o "$staging/SHASUMS256.txt" "$release/SHASUMS256.txt"
  release_entry="$(awk -v arch="$linux_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.gz$") { print $1, $2; exit }' "$staging/SHASUMS256.txt")"
  [ -n "$release_entry" ] || fail "Node.js 发布目录缺少适用的 Linux 安装包。"
  IFS=' ' read -r checksum archive <<EOF
$release_entry
EOF
  case "$checksum" in
    *[![:xdigit:]]*) fail "无法识别 Node.js 安装包的校验值。" ;;
  esac
  [ "${#checksum}" -eq 64 ] || fail "无法识别 Node.js 安装包的校验值。"
  download -o "$staging/$archive" "$release/$archive"
  (cd -- "$staging" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -) || fail "Node.js 下载校验失败。"
  mkdir "$staging/node"
  tar -xzf "$staging/$archive" -C "$staging/node" --strip-components=1
  "$staging/node/bin/node" --version >/dev/null || fail "下载的 Node.js 无法在此系统运行。"
  rm -rf -- "$node_dir"
  mv -- "$staging/node" "$node_dir"
)

install_mac_tools() {
  if ! find_brew; then install_homebrew; fi
  load_tools
  find_brew || fail "没有找到 Homebrew。完成安装器提示后，请重新运行 sh setup.sh。"
  if ! node_ready; then "$brew_bin" install node@24; fi
  if ! media_ready; then "$brew_bin" install ffmpeg-full; fi
}

install_linux_tools() {
  if ! node_ready; then
    [ -n "$node_dir" ] || fail "该 CPU 架构需先安装 Node.js 24.9 及以上版本。"
    if ! command -v curl >/dev/null 2>&1; then set -- "$@" curl ca-certificates; fi
  fi
  if ! media_ready; then set -- "$@" ffmpeg fonts-noto-cjk; fi
  if [ "$#" -gt 0 ]; then
    command -v apt-get >/dev/null 2>&1 || fail "请先通过系统包管理器安装 curl 和支持字幕的 FFmpeg、ffprobe。"
    if [ "$(id -u)" = 0 ]; then
      apt-get update
      apt-get install -y "$@"
    else
      command -v sudo >/dev/null 2>&1 || fail "安装系统包需要 sudo，也可以请管理员先安装 $*。"
      sudo apt-get update
      sudo apt-get install -y "$@"
    fi
  fi
  if ! node_ready; then install_linux_node; fi
}

load_tools
if [ "$setup" = true ] && { ! node_ready || ! media_ready; }; then
  printf '正在安装缺少的运行环境。\n'
  if [ "$platform" = Darwin ]; then install_mac_tools; else install_linux_tools; fi
  load_tools
fi
node_ready || fail "需要 Node.js 24.9 及以上版本和 npm，请先运行 sh setup.sh。"
media_ready || fail "需要 ffprobe 和支持字幕、H.264、AAC 的 FFmpeg。请运行 sh setup.sh，或检查 FFMPEG_PATH 和 FFPROBE_PATH。"

# Check before building or opening the database, so an existing service can keep running.
port="${DOMAN_PORT:-5179}"
node -e '
  const port = Number(process.argv[1]);
  if (!/^[1-9][0-9]*$/.test(process.argv[1]) || port < 1024 || port > 65535) {
    console.error("do漫：DOMAN_PORT 必须是 1024 到 65535 之间的整数。");
    process.exit(1);
  }
  const probe = require("node:net").createServer();
  probe.on("error", (error) => {
    console.error(error.code === "EADDRINUSE"
      ? "do漫：端口 " + port + " 已在使用。可停止旧服务，或给另一个项目设置 DOMAN_PORT。"
      : "do漫：无法监听 127.0.0.1:" + port + "（" + error.code + "）。");
    process.exitCode = 1;
  });
  probe.listen(port, "127.0.0.1", () => probe.close());
' "$port"

if [ "$setup" = true ]; then
  printf '正在安装项目依赖。\n'
  npm run install:ci -- --include=dev
  printf '正在构建 do漫。\n'
  npm run build
fi
[ -d node_modules/esbuild ] && [ -f dist/server/index.mjs ] && [ -f dist/client/index.html ] ||
  fail "项目还未初始化，请先运行 sh setup.sh。"

printf '正在启动 do漫，服务就绪后请打开 http://127.0.0.1:%s。\n' "$port"
exec npm start -- --hostname 127.0.0.1 --port "$port"
