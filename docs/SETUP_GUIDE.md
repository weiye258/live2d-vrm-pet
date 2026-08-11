# AI 部署指引（给 AI 助手）

> 本文档写给 **AI 助手**（agent）看，不是给人类用户看的。
> 使用场景：使用者（电脑小白）把本仓库的 GitHub 链接丢给 AI 助手，助手按本手册一步步引导安装。
> 目标环境：Windows。目标结果：桌宠跑起来 + 可选语音输入（FunASR）+ 可选语音输出（OmniVoice）。

## 0. 先搞清楚几件事

1. **桌宠本体**：Node.js + Electron 项目，无编译、无原生依赖，安装很简单。
2. **语音输入（STT，听用户说话）**：仓库自带，就两个 bat 在 `funasr/` 目录（`install.bat` 装依赖、`start.bat` 启动服务），需装 Python 3.10/3.11，可自动完成。
3. **语音输出（TTS，让桌宠说话）**：**不能自动安装**。用的是 B 站"秋叶"的 OmniVoice 整合包（体积巨大，含 Python 环境、模型权重、编译组件，由整合包作者分发）。你的职责是：引导人类下载解压 → 引导启动 → 对端口。不要尝试从仓库复刻或在线脚本安装 TTS 服务。
4. **项目里的脚本都是干嘛的**（大白话版）：

| 脚本 | 干嘛的 | 什么时候用 |
|---|---|---|
| `start.bat` | 一键启动桌宠：自动关掉旧进程、后台拉起本地服务、弹出桌宠窗口 | 平时启动，双击就行 |
| `start-log.bat` | 同上，但会把每次对话的完整记录写进 `logs/` 文件夹 | 桌宠出毛病、想查原因时用 |
| `start.ps1` | 上面两个的 PowerShell 版本，功能一样 | 基本不用管，有前两个就够了 |
| `funasr\install.bat` | 安装语音识别（STT）的依赖，一次就行 | 装 STT 时用 |
| `funasr\start.bat` | 启动语音识别服务，窗口不能关 | 用 STT 时每次开 |

涉及下载的部分，国内网络优先配镜像（见第 3 节），失败率能降一大半。

## 1. 环境检查（先跑一遍再往下走）

| 项目 | 要求 | 检查命令 | 没有怎么办 |
|---|---|---|---|
| Node.js | ≥ 18（建议 20 LTS） | `node -v` | 让人类去 nodejs.org 装 LTS，一路下一步 |
| npm | 随 Node 自带 | `npm -v` | 同上 |
| Python | 3.10 或 3.11，**勾选 Add Python to PATH** | `python --version` | 仅语音输入需要；让人类去 python.org 装，务必勾 PATH |
| NVIDIA 显卡 | 有最好（TTS 必需、STT 加速） | `nvidia-smi` | 没独显：放弃 TTS，STT 用 CPU 也能跑 |

## 2. 克隆仓库

```bat
cd /d D:\
git clone <仓库URL> live2d-pet
cd live2d-pet
```

人类电脑没有 git？两个办法任选：
- 装 [Git for Windows](https://git-scm.com/download/win)（一路下一步）；
- 或让人类在 GitHub 页面点 "Code → Download ZIP"，解压到 `D:\live2d-pet`。效果一样。

## 3. 安装桌宠依赖

```bat
npm install
```

卡住 / 报网络错误时，先配镜像再重试：

```bat
npm config set registry https://registry.npmmirror.com
setx ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
```

> 第 2 条 `setx` 是给 Electron 二进制加速的，不设也能装，就是慢。

## 4. 配置 API Key（在设置界面填，不用手改 json）

**不用拿记事本去编辑 json 填 Key**——桌宠设置窗口里有专门的 API 配置表单，是官方填法。

第 1 步，生成配置文件（复制一份示例，程序要用，就一条命令）：

```bat
copy config.example.json config.json
```

第 2 步，先把桌宠启动起来（见第 5 节），然后在设置界面填 Key：

1. 在桌宠身上点右键（或右下角托盘图标）→ 打开 **设置** 窗口；
2. 找到 **API 配置** 区域，有三个输入框：Base URL、API Key、模型名；
3. 按默认 DeepSeek 填：
   - Base URL：`https://api.deepseek.com/v1`；
   - API Key：在 platform.deepseek.com 申请的那串（sk- 开头）；
   - 模型名：`deepseek-chat`；
4. 点 **保存配置**，按钮变成"已保存 ✓"即成功。

> 支持任意 OpenAI 兼容接口；可配置多个 API 服务并切换（API 预设功能）。注意 API Key 是敏感信息，别发给别人、别提交到仓库。

## 5. 启动桌宠（核心验收，必须过）

两种方式随便挑一种，效果一样：

- **方式一（推荐给小白）**：让人类直接双击 `start.bat`。它会自己干活：先杀掉之前残留的旧进程，再在后台启动本地服务，然后弹出桌宠窗口，全程不用管。
- **方式二（你手动跑）**：在项目目录执行 `npm start`。

预期现象：
- 桌面出现透明桌宠（默认 haru）；
- 右下角托盘出现图标和完整菜单；
- 没有任何报错弹窗。

辅助检查（另开一个 CMD）：

```bat
netstat -ano | findstr "8740"
```

能看到 `LISTENING` 即本地服务正常。8740 被占用就改 `config.json` 的 `port` 字段再启动。

**如果桌宠没起来或闪退**：别急着瞎调，先双击 `start-log.bat` 重新启动一次——它会记录详细日志到 `logs/` 文件夹（`server.log`、`model-request.log`）。然后让人类把 `logs/` 里的内容发给你，按日志报错来修，比瞎猜快得多。

**过了这关 = 桌宠本体完成。** 剩下的都是可选语音。

## 6. 可选：语音输入（STT，FunASR，仓库自带）

**项目里语音输入就两个 bat，全在 `funasr/` 目录下，没有第三个：**

| bat | 干嘛的 | 跑几次 |
|---|---|---|
| `funasr\install.bat` | 装识别依赖（pip 装 funasr/modelscope/torch） | 每台电脑只装一次 |
| `funasr\start.bat` | 启动识别服务（占 8766 端口） | 每次要用语音都得开 |

前置：Python 3.10/3.11 已装且勾了 PATH（没有就按第 1 节补）。

第 1 步，装依赖。**你自己跑，不用让人类手动点**：

```bat
funasr\install.bat
```

它中途会问"有 NVIDIA 显卡吗？(y/n)"——你直接跑 `nvidia-smi` 探测：能输出显卡信息就选 y，报错就选 n（CPU 也能跑，就是慢点）。装依赖要几分钟，正常。

第 2 步，启动识别服务：

```bat
funasr\start.bat
```

- 首次启动会自动下载识别模型（约 1GB，缓存在 `funasr/models_cache/`），等窗口出现 `server ready` 才算就绪；
- 这个窗口/进程**不能关**，关了语音就没了；
- 如果 8766 端口已有服务在跑，它会自动跳过，不会重复启动，这是设计好的。

第 3 步，验证端口：

```bat
netstat -ano | findstr "8766"
```

看到 `LISTENING` 就成功。

第 4 步，让人类在桌宠 **设置 → 语音**：STT 地址填 `http://127.0.0.1:8766`，打开"语音输入"开关，重启桌宠，对着麦克风说话测试。

常见坑：
- 提示找不到 Python → PATH 没勾上，让人类重装时勾选，或手动把 Python 目录加进系统环境变量；
- 模型下载慢/失败 → 配代理，或 `setx HF_ENDPOINT https://hf-mirror.com` 后重跑 `funasr\start.bat`；
- 8766 被占用 → 改 `funasr/gf_live2d_asr_server.py` 顶部的端口变量，桌宠设置里的地址同步改。

## 7. 可选：换模型（Live2D / VRM）

仓库自带三个 Live2D 官方示例（haru / koharu / shizuku），克隆即可用，桌宠默认 haru。想换模型有两种方式：

**方式 A：加 Live2D 模型**
1. 把 Live2D 模型目录放进 `models/`（如 `models/xxx/`，其中含 `xxx.model3.json` 或 `xxx.model.json`）；
2. 桌宠 **设置 → Live2D / VRM 模型**：自定义路径填 `models/xxx/xxx.model3.json` → 点"添加到列表"；
3. 在列表里选中 → 点"应用"，桌宠立即切换。

**方式 B：加 VRM 模型（3D 立绘）**
1. 让人类从 VRoid Hub 等网站下载喜欢的 VRM 模型（`.vrm` 单文件，几 MB 到几十 MB）；
2. 把 `.vrm` 文件放进 `models/vrm/`（如 `models/vrm/我的角色.vrm`）；
3. 桌宠 **设置 → Live2D / VRM 模型**：自定义路径填 `models/vrm/我的角色.vrm` → 点"添加到列表" → 选中 → 点"应用"。

VRM 模型的操作和 Live2D 略有不同：
- **滚轮**缩放大小，**鼠标右键拖动**调整位置（位置会自动记住，重启不丢）；
- 触摸区域、动作/表情触发等按模型分开保存，切换模型互不影响。

> 注意：`models/vrm/` 在 `.gitignore` 里（体积大/版权不明，不入库），克隆仓库后该目录为空，需人类自己放文件，属正常。

## 8. 可选：语音输出（TTS，OmniVoice，秋叶整合包）

**先说清楚：项目仓库里没有任何 TTS 的 bat。** TTS 的启动脚本在秋叶整合包内部，由整合包作者写好、跟着压缩包一起分发，我们无法从仓库里给你。所以这一步必须让人类先拿到整合包，后面的事你自己来。

第 1 步，人类下载整合包（这步只能人类来，因为要登录/付费/加群，AI 干不了）：
- 在 B 站搜索"秋叶 OmniVoice"，或直接向作者要压缩包；
- 下载后解压到如 `D:\OmniVoice`。体积几十 GB，下载+解压都要等很久，正常现象。

第 2 步，你自己去整合包目录里找启动脚本：
- 通常在解压后的目录里有一个 `.bat`（名字不定，可能是 `启动.bat`、`一键启动.bat`、`start.bat` 之类），也可能有 `说明.txt` 或作者教程，**先读它们**再动手；
- 找到后执行它，等黑窗口提示**模型加载完成 / 服务就绪**（首次启动几分钟到十几分钟，正常）；
- 如果目录里有多个 bat 拿不准，就打开每个看看里面的说明文字，选描述为"启动/运行"的那个。

第 3 步，确认端口（以整合包实际输出为准，一般 9881）：

```bat
netstat -ano | findstr "9881"
```

第 4 步，让人类在桌宠 **设置 → 语音**：TTS 地址填 `http://127.0.0.1:9881`（若整合包端口不同，以它为准），选一个音色，打开"语音输出"开关，让桌宠说句话测试。

硬性前提：**NVIDIA 显卡（CUDA）**。没有独显基本跑不动，直接放弃 TTS，用打字 + 语音输入。

## 9. 全部验收清单

- [ ] 桌宠出现，能正常聊天
- [ ] 设置页能切换模型（Live2D 与 VRM 均可）
- [ ] 可选：装了 STT，说话能识别成文字
- [ ] 可选：装了 TTS，桌宠能开口说话

## 10. 故障排查速查表

| 症状 | 处理 |
|---|---|
| `npm install` 失败/超时 | 配 npmmirror 镜像（第 3 节）重试 |
| 启动即闪退 | 看控制台报错；确认 Node ≥ 18 |
| 桌宠不回复 | 检查 `config.json` 的 base/key/model；确认网络可达 |
| 端口 8740 被占用 | 改 `config.json` 的 `port` |
| STT 连不上 | 确认 `funasr\start.bat` 窗口还开着；`netstat` 查 8766 |
| TTS 没声音 | 确认整合包就绪、TTS 地址端口与整合包一致、系统音量与默认播放设备 |
| 语音服务都正常但桌宠静音 | 检查系统"声音设置"的默认输出设备与音量 |

## 11. 边界与注意事项

- `.gitignore` 已排除的文件克隆后**不会出现**，属正常，别当成缺文件：`config.json`（含 API Key）、`characters/`（角色卡）、`chat-history/`、`memories/`（隐私数据）、`models/vrm/`（用户自放模型）、`models/blhx_z23/`（商业游戏资产，勿分发）、`funasr/models_cache/`（模型缓存，首次启动自动下载）。
- 角色卡、聊天记录、记忆是用户隐私，**不要**提交到公开仓库。
- 仓库自带 Live2D 官方示例模型（haru / koharu / shizuku），克隆即可用；加自选 Live2D / VRM 模型的完整步骤见第 7 节。
- 改完配置后要重启桌宠才生效（`npm start` 每次都是全新进程，无热重载）。
- 模型加载完成前，TTS/STT 开关可以先开着，服务就绪后即自动可用。
