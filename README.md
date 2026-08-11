# Live2D Desktop Pet

一个会动、会说话、会陪你聊天的 Live2D 桌面宠物。支持多角色、语音对话（TTS/STT）、记忆系统、可配置动作表情触发。

## 功能

- 🖥️ 透明悬浮窗桌宠，可拖动、可缩放、可全屏穿透
- 💬 聊天对话（OpenAI 兼容 API，默认 DeepSeek）
- 🎭 多角色卡：每个角色独立人设、模型、语音、记忆
- 🧠 记忆系统：事实/事件/物品/喜好自动沉淀
- 🎤 TTS 语音输出（OmniVoice）+ STT 语音输入（FunASR）
- 👁 视线跟随鼠标 + 自主小动作 + 自主找话题（可开关）
- 🎬 词→动作/表情触发：配置关键词，文本中出现即播放对应动作
- 🪟 独立窗口：聊天/角色/设置/记忆 均可独立弹出

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API

```bash
copy config.example.json config.json
```

编辑 `config.json`，填入你的 API Key：

```json
{
  "api": {
    "base": "https://api.deepseek.com/v1",
    "key": "sk-你的key",
    "model": "deepseek-chat"
  }
}
```

> 支持任意 OpenAI 兼容接口。可在设置界面配置多个 API 服务并切换。

### 3. 启动

```bash
npm start        # 或双击 start.bat
```

启动后桌面会出现桌宠，右下角托盘有完整菜单。

## 可选：语音服务（TTS/STT）

语音不是必需功能：不配置也能正常聊天（打字）。语音服务需单独启动，项目仓库自带 FunASR 流式服务脚本（`funasr/`），按下面步骤配置即可。

| 服务 | 用途 | 默认地址 | 仓库自带 |
|------|------|----------|----------|
| [OmniVoice](https://github.com/Omni-Voice/OmniVoice) | TTS 语音合成（她说） | http://127.0.0.1:9881 | 否，用秋叶整合包 |
| [FunASR](https://github.com/modelscope/FunASR) | STT 语音识别（听你说） | http://127.0.0.1:8766 | 是（`funasr/`） |

### STT 语音输入（FunASR）安装（小白版）

1. 安装 Python 3.10 或 3.11（[官网下载](https://www.python.org/downloads/)），安装时**务必勾选 "Add Python to PATH"**；
2. 双击 `funasr/install.bat` 安装依赖（有 NVIDIA 显卡选 y 装 GPU 版，更快；没有就选 n 装 CPU 版，也能用）。装完关闭窗口；
3. 双击 `funasr/start.bat` 启动语音服务：首次启动会自动下载识别模型（约 1GB），出现 `server ready` 即成功。**这个窗口不要关**，关掉语音就没了；
4. 桌宠设置 → 语音 → STT 地址填 `http://127.0.0.1:8766` → 打开"语音输入"开关；
5. 重启桌宠后对她说说话试试。

> 提示：`start.bat` 会自动检测 Python 并启动服务，无需改任何路径；模型缓存在 `funasr/models_cache/`，删掉可重新下载。

### TTS 语音输出（OmniVoice，可选）

让桌宠"开口说话"。OmniVoice 使用 **B 站秋叶出品的 AI 语音整合包**（自带一键启动脚本，无需手动部署）：

1. 在 B 站搜索"秋叶 OmniVoice"下载整合包（或直接向作者要整合包压缩包）；
2. 解压后，按整合包自带说明/一键启动脚本启动语音服务；
3. 等黑窗口提示模型加载完成、服务就绪；
4. 桌宠设置 → 语音 → TTS 地址填 `http://127.0.0.1:9881` → 选音色 → 打开"语音输出"开关；
5. 若整合包实际端口不是 9881，以它为准修改地址。

> 注意：OmniVoice 依赖 NVIDIA 显卡（CUDA）。没有独显的电脑大概率跑不动，建议只用打字 + 语音输入。
> **给 AI 助手**：完整安装/排查步骤见 [AI 部署指引](docs/SETUP_GUIDE.md)。直接把本仓库链接发给你的 AI 助手，让它照着手册引导你安装。

### 常见语音问题

- **启动 `start.bat` 提示找不到 Python**：说明没勾 PATH。重装 Python 勾选 "Add Python to PATH"，或手动把 Python 安装目录加入系统环境变量 PATH；
- **模型下载慢/失败**：设置系统环境变量 `HF_ENDPOINT=https://hf-mirror.com` 后重试；或使用代理；
- **8766 端口被占用**：修改 `funasr/gf_live2d_asr_server.py` 顶部 `GF_ASR_PORT` 环境变量（或直接改 `PORT`），并把桌宠设置里的 STT 地址改成对应端口；
- **识别不准**：靠近麦克风、环境安静；桌面宠用的是 16k 采样率麦克风流；
- **TTS 没有声音/服务未就绪**：确认整合包已按说明启动且模型加载完成；服务端口以整合包实际为准，与桌宠设置里的地址保持一致；
- **说话没声音但服务正常**：检查系统音量、默认播放设备。

## 使用说明

### 角色

- 点 🎭 打开角色窗口：新建/编辑/删除角色卡
- 每个角色可配置：人设描述、性格、场景、开场白、模型、语音、记忆间隔、规则
- 内置免费模型：haru、shizuku、koharu（Live2D 官方示例模型）

### 自定义模型

1. 将 Live2D 模型（.model3.json 或 .model.json）放入 `models/` 目录
2. 设置 → Live2D 模型 → 自定义路径填 `models/你的模型/xxx.model3.json` → 添加到列表
3. 在列表选中 → 应用

### 词→动作/表情触发

设置 → 动作/表情触发：

- 关键词：逗号分隔，聊天文本中出现任一即触发
- 类型：动作（播放模型动作）或 表情（切换模型表情）
- 动作/表情名从当前模型的实际列表中选择

### 记忆系统

- 对话按角色的 `memory_interval`（默认 20 条）自动沉淀到记忆
- 🧠 记忆窗口可手动查看/增删改
- 在对话中明确说"忘掉这件事"可清除对应记忆

## 项目结构

```
live2d-pet/
├── main.js            # Electron 主进程（窗口/托盘/穿透/全屏跟随）
├── server.js          # 本地服务器（127.0.0.1:8740）
├── app.js             # 桌宠主窗口前端
├── index.html         # 主窗口
├── chat.html          # 独立聊天窗口
├── settings.html      # 独立设置窗口
├── memory.html        # 独立记忆窗口
├── characters.html    # 独立角色窗口
├── characters/        # 角色卡（JSON）
├── chat-history/      # 聊天记录（每角色一个文件）
├── memories/          # 记忆文件（每角色一个文件）
├── funasr/            # 语音输入服务（可选）：install.bat 装依赖、start.bat 启动
└── models/            # Live2D 模型
```

## 常见问题

**Q: 端口被占用？**
A: 修改 `config.json` 的 `port` 字段。

**Q: 重启后模型变回默认？**
A: 模型绑定在角色卡上。设置 → Live2D 模型 → 选中 → 应用，会保存到当前角色。

**Q: 桌宠不说话了？**
A: 检查 API Key 是否正确、网络是否可达。renderer.log 有调试日志。

## 开源许可

MIT License。详见 [LICENSE](LICENSE)。

**注意**：`models/blhx_z23/`（碧蓝航线角色）为商业游戏资产，仅供个人学习，**请勿分发**。仓库默认通过 .gitignore 排除该目录。
