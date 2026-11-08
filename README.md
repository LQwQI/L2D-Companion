# L2D Companion

> 一个可以让你的 Live2D 模型常驻在桌面上的小工具。

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D4?logo=windows&logoColor=white)](#)
[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

把任意 Cubism 3/4/5 模型丢进桌面：透明白底、鼠标穿透、跟随视线、点哪里说哪句话。
接上本地 AI 角色后，它还会自己开口跟你搭话。

<!-- 截图：把一张干净的桌面截图放到 docs/screenshot.png，再把下面这行取消注释 -->
<!-- ![screenshot](docs/screenshot.png) -->

## 功能

**模型**

- 导入模型文件夹，自动扫描 `.model3.json`，支持多模型切换
- 参数面板：搜索参数名 / ID、手动覆盖任意参数、一键重置
- 缩放、上下偏移、水平镜像，视图一键重置

**桌面**

- 窗口大小预设（小 / 中 / 大 / 超大）与不透明度连续调节
- 固定模型（锁定位置 + 鼠标穿透）、固定位置（不穿透）、透明区拖动
- 双击透明区下沉一层，下沉后会提示用 `Ctrl+Alt+T` 或托盘菜单提回最上层
- 始终置顶、视线与身体跟随鼠标、手臂随呼吸轻摆
- 位置记忆点：保存当前位置和大小，下次一键跳回

**互动**

- 区域台词：点角色不同部位说不同的话（每行一条，可留空用默认）
- 区域触碰表情、自定义触碰点（可视化抓取坐标）
- 聊天气泡位置可拖动调整，双击气泡直接打开 AI 对话

**表情 / 动作**

- 表情列表一点即用，可设置互动后自动关闭的秒数
- 动作列表播放，播完自动回待机，也可随时强制回待机

**AI（可选）**

- **AI 对话目前只支持本地 SurfCore 服务** —— OpenAI / Claude / Ollama 等其它后端暂不支持
- 接上 SurfCore 后可以用角色人格对话，桌面端和 QQ 端共用同一份人设
- 自动主动搭话，间隔 10 / 20 / 30 / 60 / 120 分钟可选
- 本地 HTTP API：外部程序（脚本、机器人、快捷键工具）可以让角色说话，
  请求头带 `x-pet-token`，连续失败会临时锁定

> AI 是可选功能：不装 SurfCore，模型显示、表情、动作、触碰互动全都照常能用，
> 只是 AI 页会显示未连接。

> ⚠️ **「启用 SurfCore」和「自动说话」这两个开关目前不要关**，关闭后可能崩溃、之后也恢复不了。
> 想让它安静一会儿，把「自动说话间隔」调到 120 分钟就行。细节见下面的[常见问题](#常见问题)。

## 下载

到 [Releases](../../releases) 下载最新版本：

| 文件 | 说明 |
| --- | --- |
| `L2D-Companion-x.y.z-setup.exe` | NSIS 安装版，可自选安装目录，建桌面和开始菜单快捷方式 |
| `L2D-Companion-x.y.z-portable.exe` | 便携版，双击即用，不写注册表 |
| `SHA256SUMS.txt` | 上面两个文件的 SHA256 |

系统要求：Windows 10 / 11 x64。

## 从源码运行

```powershell
# 1. 安装依赖（只需要 electron-builder）
npm install

# 2. 放入 Live2D Cubism Core（见下一节，仓库不包含）
#    app/core/live2dcubismcore.min.js

# 3. 启动（Electron 45）
npx electron@45.2.3 .
```

打包：

```powershell
# 方式 A：官方 Electron 45.2.3 解压到 electron-dist/ 后直接打包（离线）
npx electron-builder --win

# 方式 B：删掉 package.json 里的 "electronDist" 字段，让 electron-builder 自己下载
```

## 关于 Live2D Cubism Core

`app/core/live2dcubismcore.min.js` 是 **Live2D 公司的专有运行时**，受 Live2D 的许可协议约束，
**不随本仓库分发**。首次运行前请自行从 [Live2D 官网](https://www.live2d.com/sdk/cubism/) 下载
Cubism SDK for Web 并取出 `Core/live2dcubismcore.min.js`，放到 `app/core/` 下。

同理，Live2D 模型（`.moc3` / 贴图 / 动作 / 表情）的版权属于模型作者，请只在获得授权的前提下使用和分发。

## 项目结构

```
app/
  main.js        主进程：窗口、托盘、鼠标穿透、IPC、本地 HTTP API
  preload.js     渲染层与主进程之间的受控桥接
  panel.*        参数面板（模型 / AI / 互动 / 表情 / 动作 / 设置）
  pet.html       桌宠窗口
  renderer.js    Live2D 渲染层
  bubble.*       聊天气泡
  chat.*         AI 对话窗
  surfcore.js    本地 SurfCore 连接与本地 API 鉴权
  model-scan.js  模型文件夹扫描与解析
  core/          Live2D Cubism Core（需自行放置）
build/           打包资源（图标）
```

## 配置文件

设置保存在 `%APPDATA%\deepseek-live2d-pet\config.json`（安装版和便携版都写到这儿）。
面板上的开关会自动存进去；下面几项面板里没有对应的 UI，需要手动加：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `qqLink` | `true` | 是否启用外部联动 |
| `qqLinkPaths.script` | 自动探测 | 联动脚本 `qq-link-daemon.mjs` 的绝对路径 |
| `qqLinkPaths.node` | 自动探测 | 用哪个 `node.exe` 跑那个脚本 |
| `qqLinkPaths.pidFile` | 脚本同目录 | 守护进程 pid 文件位置 |
| `surfcoreConfig` | `~/.dsh/surfcore/config.json` | SurfCore 的 `config.json`，里面带 SnowLuma token 和 `ownerQQ`，用来给主人发 QQ |

不想改文件也可以用环境变量覆盖：`L2D_QQ_LINK_DAEMON`、`L2D_NODE_EXE`、`L2D_SURFCORE_CONFIG`。

探测顺序是 **环境变量 → 配置文件 → 常见安装位置**（程序目录、`%APPDATA%` 下的 `qq-link/`、`PATH`、
`C:\Program Files\nodejs` 等）。**全都找不到就静默跳过**，桌宠本身照常运行 —— 外部联动是可选功能，
不影响模型、表情、动作这些核心玩法。

## 常见问题

**⚠️ 关掉「启用 SurfCore」或「自动说话」之后崩了 / 打不开了**
这是目前**已知问题**：AI 页的这两个开关一旦关掉，程序可能崩溃，之后再打开也可能恢复不了。

- 想让它安静一会儿：**不要关开关**，把「自动说话间隔」改成 `120 分钟`，或者干脆不理它
- 已经关掉、现在启动就崩：先完全退出桌宠（托盘图标右键 → 退出），再用记事本打开
  `%APPDATA%\deepseek-live2d-pet\config.json`，把 `surf` 里的 `enabled` 和 `autoTalk` 改回 `true`：
  ```json
  "surf": { "enabled": true, "autoTalk": true, "intervalMin": 120, "apiPort": 3199, "apiToken": "" }
  ```
  存盘后再启动。（改之前建议先把整个文件复制一份备份。）

**AI 能不能接 OpenAI / Claude / Ollama**
暂时不行，目前**只做了 SurfCore 一个后端**。桌宠这边发请求、收回复、走人设都是按 SurfCore 的接口来的，
换后端不只是改个 URL。后面有空会做成可插拔的。

不方便装 SurfCore 也没关系：模型、参数、表情、动作、触碰、气泡台词这些都不依赖 AI，可以正常用，
只是 AI 页会一直显示未连接。

**启动后白屏 / 提示找不到模型**
多半是缺 `app/core/live2dcubismcore.min.js`，按上一节放进去再试。

**杀毒软件报可疑**
未签名的 Electron 打包程序常被误报。代码全部开源可自行审计，也可以按“从源码运行”自己跑。

**模型点了没反应**
检查「设置 → 固定模型」是否开启了鼠标穿透；穿透状态下点击会直接落到下层窗口。

## 作者留言

这个项目一开始只是给自己写的小工具。

想要的东西其实很简单：一个能一直待在桌面角落的 Live2D 模型，点它会说话，放着不管它也会偶尔主动开口。
试过几个现成的桌宠，要么只能循环播放动作，要么 AI 对话被单独做成了聊天窗口，模型和对话是割裂的两件事。
后来干脆自己写一个 —— 模型、参数、表情、动作、触碰、AI 全接在一起，双击气泡就能直接跟角色说话。

做久了它就不只是玩具了。早上打开电脑看到它在屏幕上，一天会踏实很多。

决定开源，是觉得应该有不少人也想要这样一个桌面角落。代码谈不上优雅，有些地方是"能跑就行"堆出来的，
但它确实每天都在工作。

接下来想做的事：

- 把上面列出的已知问题修掉
- 让模型适配更省事 —— 现在换一个模型还得在参数面板里手调半天
- 支持更多 AI 后端，不必局限在本地 SurfCore

如果你也在用它，欢迎在 Issues 里留一句，哪怕只是"在用"，对一个人写的项目来说都很重要。

—— LQwQI

## 参与

欢迎提 Issue 和 PR。提交前请确认没有把个人路径、token 或未授权的模型资源带进来。

## License

[MIT](LICENSE) © L2D Companion
