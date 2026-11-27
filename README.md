# do漫

在终端进入项目目录（与 `package.json` 同级）。

首次启动：

```sh
sh setup.sh
```

首次启动需要联网。macOS 支持 Apple 芯片和 Intel，脚本会识别芯片和系统版本，把缺少的预编译工具装到项目目录，然后安装依赖、构建并启动。Node.js 24 的 Mac 预编译版需要 macOS 13.5 或以上。Ubuntu、Debian（包括 WSL）安装系统包时可能需要管理员密码。

日常启动：

```sh
sh start.sh
```

启动后打开 [http://127.0.0.1:5179](http://127.0.0.1:5179)。在启动终端按 `Ctrl+C` 停止服务。

端口被占用时，可运行 `DOMAN_PORT=5180 sh start.sh`，然后访问 [http://127.0.0.1:5180](http://127.0.0.1:5180)。
