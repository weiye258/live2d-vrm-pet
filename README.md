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

本项目不自带语音服务，需单独启动：

| 服务 | 用途 | 默认地址 |
|------|------|----------|
| [OmniVoice](https://github.com/Omni-Voice/OmniVoice) | TTS 语音合成 | http://127.0.0.1:9881 |
| [FunASR](https://github.com/modelscope/FunASR) | STT 语音识别 | http://127.0.0.1:8766 |

在设置界面的"语音"区块填入服务地址，开启对应开关即可。

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
