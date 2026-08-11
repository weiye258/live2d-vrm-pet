# AI 部署指引（给 AI 助手）

> 本文档写给 **AI 助手**（agent）看，不是给人类用户看的。
> 使用场景：使用者（电脑小白）把本仓库的 GitHub 链接丢给 AI 助手，助手按本手册一步步引导安装。
> 目标环境：Windows。目标结果：桌宠跑起来 + 可选语音输入（FunASR）+ 可选语音输出（OmniVoice）。

## 0. 先搞清楚三件事

1. **桌宠本体**：Node.js + Electron 项目，无编译、无原生依赖，安装很简单。
2. **语音输入（STT，听用户说话）**：仓库自带 FunASR 流式服务脚本（`funasr/`）+ 一键 bat，需装 Python 3.10/3.11。可自动完成。
3. **语音输出（TTS，让桌宠说话）**：**不能自动安装**。用的是 B 站"秋叶"的 OmniVoice 整合包（体积巨大，含 Python 环境、模型权重、编译组件，由整合包作者分发）。你的职责是：引导人类下载解压 → 引导启动 → 对端口。不要尝试从仓库复刻或在线脚本安装 TTS 服务。

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

## 4. 配置 API Key

```bat
copy config.example.json config.json
```

用记事本编辑 `config.json`，在 `api` 段填 Key：

```json
"api": {
  "base": "https://api.deepseek.com/v1",
  "key": "sk-你的key",
  "model": "deepseek-chat"
}
```

- 默认走 DeepSeek（key 在 platform.deepseek.com 申请）；
- 任意 OpenAI 兼容接口都行；设置界面里也能配多个并切换。

## 5. 启动桌宠（核心验收，必须过）

```bat
npm start
```

预期现象：
- 桌面出现透明桌宠（默认 haru）；
- 右下角托盘出现图标和完整菜单；
- 没有任何报错弹窗。

辅助检查（另开一个 CMD）：

```bat
netstat -ano | findstr "8740"
```

能看到 `LISTENING` 即本地服务正常。8740 被占用就改 `config.json` 的 `port` 字段再启动。

**过了这关 = 桌宠本体完成。** 剩下的都是可选语音。

## 6. 可选：语音输入（FunASR STT，仓库自带，可自动）

前置：Python 3.10/3.11 已装且勾了 PATH（见第 1 节）。

第 1 步，安装依赖（问人类有没有 NVIDIA 显卡，有选 y，没有选 n）：

```bat
funasr\install.bat
```

第 2 步，启动语音服务（首次启动自动下载识别模型约 1GB，看到 `server ready` 字样即成功，窗口保持打开不要关）：

```bat
funasr\start.bat
```

第 3 步，确认端口在听：

```bat
netstat -ano | findstr "8766"
```

第 4 步，让人类在桌宠 **设置 → 语音**：STT 地址填 `http://127.0.0.1:8766`，打开"语音输入"开关，重启桌宠，对着麦克风说话试试。

常见坑：
- 提示找不到 Python → PATH 没勾上，让人类重装时勾选，或手动把 Python 安装目录加进系统环境变量 PATH；
- 模型下载慢/失败 → 设代理，或设 `HF_ENDPOINT=https://hf-mirror.com` 后重跑 `start.bat`；
- 8766 被占用 → 改 `funasr/gf_live2d_asr_server.py` 顶部的端口变量，并把设置里 STT 地址改成一致。

## 7. 可选：语音输出（OmniVoice TTS，秋叶整合包，人类手动下载）

**为什么不能自动装**：整合包自带 Python 环境、模型权重和编译好的加速组件，几十 GB 级别，只能由整合包作者分发的压缩包提供。仓库层面没有任何安装脚本，不要试图现场部署或 pip 装。

你的操作流程：

1. 让人类在 B 站搜索 **"秋叶 OmniVoice"**（或直接向作者要整合包压缩包），下载后解压到如 `D:\OmniVoice`；
2. 在整合包目录里找一键启动脚本（通常是个 `.bat`），双击启动；
3. 等黑窗口提示**模型加载完成 / 服务就绪**（首次启动可能几分钟到十几分钟，正常现象）；
4. 确认端口（以整合包实际输出为准，一般 9881）：

```bat
netstat -ano | findstr "9881"
```

5. 让人类在桌宠 **设置 → 语音**：TTS 地址填 `http://127.0.0.1:9881`（若实际端口不同，以整合包为准），选一个音色，打开"语音输出"开关，让桌宠说句话试试。

硬性前提：**NVIDIA 显卡（CUDA）**。没有独显基本跑不动，建议直接放弃 TTS，改用打字 + 语音输入。

## 8. 全部验收清单

- [ ] 桌宠出现，能正常聊天
- [ ] 设置页能切换模型（Live2D 与 VRM 均可）
- [ ] 可选：装了 STT，说话能识别成文字
- [ ] 可选：装了 TTS，桌宠能开口说话

## 9. 故障排查速查表

| 症状 | 处理 |
|---|---|
| `npm install` 失败/超时 | 配 npmmirror 镜像（第 3 节）重试 |
| 启动即闪退 | 看控制台报错；确认 Node ≥ 18 |
| 桌宠不回复 | 检查 `config.json` 的 base/key/model；确认网络可达 |
| 端口 8740 被占用 | 改 `config.json` 的 `port` |
| STT 连不上 | 确认 `start.bat` 窗口还开着；`netstat` 查 8766 |
| TTS 没声音 | 确认整合包就绪、TTS 地址端口与整合包一致、系统音量与默认播放设备 |
| 语音服务都正常但桌宠静音 | 检查系统"声音设置"的默认输出设备与音量 |

## 10. 边界与注意事项

- `.gitignore` 已排除的文件克隆后**不会出现**，属正常，别当成缺文件：`config.json`（含 API Key）、`characters/`（角色卡）、`chat-history/`、`memories/`（隐私数据）、`models/vrm/`（用户自放模型）、`models/blhx_z23/`（商业游戏资产，勿分发）、`funasr/models_cache/`（模型缓存，首次启动自动下载）。
- 角色卡、聊天记录、记忆是用户隐私，**不要**提交到公开仓库。
- 仓库自带 Live2D 官方示例模型（haru / koharu / shizuku），克隆即可用；VRM 模型需人类自己放文件到 `models/vrm/`。
- 改完配置后要重启桌宠才生效（`npm start` 每次都是全新进程，无热重载）。
- 模型加载完成前，TTS/STT 开关可以先开着，服务就绪后即自动可用。
