# do漫

在终端进入项目目录（与 `package.json` 同级）。

首次启动：

```sh
sh setup.sh
```

首次启动需要联网。脚本会安装缺少的运行环境和项目依赖，然后构建并启动。macOS 和 Ubuntu、Debian（包括 WSL）可自动安装环境，系统可能提示确认或输入管理员密码。

日常启动：

```sh
bash start.command
```

macOS 也可以双击 `start.command`。启动后打开 [http://127.0.0.1:5179](http://127.0.0.1:5179)。在启动终端按 `Ctrl+C` 停止服务。

端口被占用时，可运行 `DOMAN_PORT=5180 bash start.command`，然后访问 [http://127.0.0.1:5180](http://127.0.0.1:5180)。
