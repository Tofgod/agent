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

machine="$(uname -m)"
if [ "$platform" = Darwin ] && [ "$machine" = x86_64 ] &&
  [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
  machine=arm64
fi
runtime_arch=
case "$machine" in
  x86_64) runtime_arch=x64 ;;
  aarch64|arm64) runtime_arch=arm64 ;;
esac
node_dir=
media_dir=
if [ -n "$runtime_arch" ]; then
  case "$platform" in
    Darwin) node_target="darwin-$runtime_arch"; media_dir="$PWD/.studio-runtime/ffmpeg-$node_target" ;;
    Linux) node_target="linux-$runtime_arch" ;;
  esac
  node_dir="$PWD/.studio-runtime/node-$node_target"
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

load_tools() {
  brew_prefix=
  if [ "$platform" = Darwin ]; then
    brew_prefix="${HOMEBREW_PREFIX:-}"
    if [ -z "$brew_prefix" ]; then
      case ":$PATH:" in
        *:/opt/homebrew/bin:*) brew_prefix=/opt/homebrew ;;
        *:/usr/local/bin:*) brew_prefix=/usr/local ;;
      esac
    fi
  fi
  if [ -n "$brew_prefix" ]; then
    if ! node_ready && [ -x "$brew_prefix/opt/node@24/bin/node" ]; then
      export PATH="$brew_prefix/opt/node@24/bin:$PATH"
    fi
    if ! media_ready && [ -x "$brew_prefix/opt/ffmpeg-full/bin/ffmpeg" ]; then
      export PATH="$brew_prefix/opt/ffmpeg-full/bin:$PATH"
    fi
  fi
  if [ -n "$node_dir" ] && [ -x "$node_dir/bin/node" ] && ! node_ready; then
    export PATH="$node_dir/bin:$PATH"
  fi
  if [ -n "$media_dir" ] && [ -x "$media_dir/bin/ffmpeg" ] && ! media_ready; then
    export PATH="$media_dir/bin:$PATH"
  fi
}

download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --retry 2 "$@"
}

verify_archive() {
  if [ "$platform" = Darwin ]; then
    printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c -
  else
    printf '%s  %s\n' "$1" "$2" | sha256sum -c -
  fi
}

install_local_node() (
  mkdir -p .studio-runtime
  staging="$(mktemp -d "$PWD/.studio-runtime/node-install.XXXXXX")"
  trap 'rm -rf -- "$staging"' 0
  printf '正在为 %s 下载 Node.js 24 和 npm。\n' "$node_target"
  release=https://nodejs.org/dist/latest-v24.x
  download -o "$staging/SHASUMS256.txt" "$release/SHASUMS256.txt" || fail "无法读取 Node.js 发布清单，请检查与 nodejs.org 的连接。"
  release_entry="$(awk -v target="$node_target" '$2 ~ ("^node-v24[.][0-9]+[.][0-9]+-" target "[.]tar[.]gz$") { print $1, $2; exit }' "$staging/SHASUMS256.txt")"
  [ -n "$release_entry" ] || fail "Node.js 发布目录缺少 $node_target 安装包。"
  IFS=' ' read -r checksum archive <<EOF
$release_entry
EOF
  case "$checksum" in
    *[![:xdigit:]]*) fail "无法识别 Node.js 安装包的校验值。" ;;
  esac
  [ "${#checksum}" -eq 64 ] || fail "无法识别 Node.js 安装包的校验值。"
  download -o "$staging/$archive" "$release/$archive" || fail "Node.js 下载失败，请检查网络后重试。"
  (cd -- "$staging" && verify_archive "$checksum" "$archive") || fail "Node.js 下载校验失败。"
  mkdir "$staging/node"
  tar -xzf "$staging/$archive" -C "$staging/node" --strip-components=1
  [ -x "$staging/node/bin/npm" ] && PATH="$staging/node/bin:$PATH" node_ready || fail "下载的 Node.js 或 npm 无法在此系统运行。"
  rm -rf -- "$node_dir"
  mv -- "$staging/node" "$node_dir"
)

require_macos() (
  version="$(sw_vers -productVersion)"
  if ! printf '%s\n' "$version" | awk -F. -v minimum="$1" '
    BEGIN { split(minimum, required, ".") }
    $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {
      supported = ($1 + 0 > required[1] + 0 || ($1 + 0 == required[1] + 0 && $2 + 0 >= required[2] + 0))
    }
    END { exit !supported }
  '; then
    fail "$2 的预编译版本需要 macOS $1 或以上。当前系统是 macOS $version。"
  fi
)

install_mac_media() (
  # Use versioned ZIP archives and the publisher's SHA-256 values.
  case "$runtime_arch" in
    arm64)
      build=arm64/1795207104_9.1
      ffmpeg_sha=1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1
      ffprobe_sha=6ef2df5f575042923a28537ab37adf936f28bf3e7b85de23a1447ed447ec1dbd
      ;;
    x64)
      build=amd64/1795212433_9.1
      ffmpeg_sha=35b3d82cccc2c1d644d49d15f5e57eb913a08ef68f798042c90eecec62c51f1e
      ffprobe_sha=41ca7b7cba7992e33f1da3f1bf54db8ec103a4d387b1bfac3162062e8b1074ad
      ;;
  esac
  mkdir -p .studio-runtime
  staging="$(mktemp -d "$PWD/.studio-runtime/media-install.XXXXXX")"
  trap 'rm -rf -- "$staging"' 0
  mkdir -p "$staging/ffmpeg/bin"
  printf '正在为 %s 下载 FFmpeg 和 ffprobe。\n' "$node_target"
  for tool in ffmpeg ffprobe; do
    case "$tool" in ffmpeg) checksum="$ffmpeg_sha" ;; ffprobe) checksum="$ffprobe_sha" ;; esac
    url="https://ffmpeg.martin-riedl.de/download/macos/$build/$tool.zip"
    download -o "$staging/$tool.zip" "$url" || fail "$tool 下载失败，请检查网络后重试。"
    (cd -- "$staging" && verify_archive "$checksum" "$tool.zip") || fail "$tool 下载校验失败。"
    unzip -p "$staging/$tool.zip" "$tool" > "$staging/ffmpeg/bin/$tool"
    chmod +x "$staging/ffmpeg/bin/$tool"
  done
  FFMPEG_PATH="$staging/ffmpeg/bin/ffmpeg" FFPROBE_PATH="$staging/ffmpeg/bin/ffprobe" media_ready ||
    fail "下载的 FFmpeg 或 ffprobe 无法运行，或缺少字幕、H.264、AAC 能力。"
  rm -rf -- "$media_dir"
  mv -- "$staging/ffmpeg" "$media_dir"
)

install_mac_tools() {
  [ -n "$runtime_arch" ] || fail "当前 Mac 芯片架构 $machine 缺少可用的预编译包。"
  if ! node_ready; then
    require_macos 13.5 'Node.js 24'
    install_local_node
  fi
  if ! media_ready; then
    require_macos 12.0 'FFmpeg 9.1'
    install_mac_media
  fi
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
  if ! node_ready; then install_local_node; fi
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
