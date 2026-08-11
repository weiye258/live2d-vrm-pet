# 模型目录

把模型文件放在这里，服务器会自动扫描并显示在设置面板的模型列表中。

## 支持的格式

- **Live2D Cubism 2** (`.model.json` + `.moc` + `.mtn`): 老格式，如自带的 koharu/shizuku
- **Live2D Cubism 3/4** (`.model3.json` + `.moc3` + `.motion3.json`): 新格式，支持更精细的表情和物理
- **VRM** (`.vrm`): 3D 虚拟人格式，基于 glTF 2.0，支持骨骼动画、SpringBone 物理、标准化表情

## 目录结构示例

```
models/
├── assets/              ← 自带的 Cubism 2 示例模型（koharu / shizuku）
│   ├── koharu.model.json
│   └── shizuku.model.json
├── haru/                ← Cubism 4 模型示例
│   └── haru_greeter_t03.model3.json
├── vrm/                 ← VRM 模型目录
│   ├── Alicia.vrm       ← ニコニ立体ちゃん（VRM 0.x）
│   ├── Seed-san.vrm     ← VRM spec 官方示例（VRM 1.0）
│   └── VRM1_Sample.vrm  ← three-vrm 官方示例（VRM 1.0）
└── 你下载的模型/
    └── xxx.model3.json 或 xxx.vrm
```

## 在哪下载模型

### Live2D
- **Live2D 官方免费样例**: https://www.live2d.com/download/sample-data/
- **B站大佬分享的模型**: 搜索"Live2D 模型分享"
- **Booth（部分免费）**: https://booth.pm/

### VRM
- **VRoid Hub**: https://hub.vroid.com/ （pixiv 官方，需注册）
- **Booth**: https://booth.pm/ （搜索"VRM"，部分免费）
- **VRoid Studio**: 免费自捏角色，导出 VRM 格式
- **Open Source Avatars**: https://github.com/ToxSam/open-source-avatars （CC0 免费）

## 绑定模型到角色

在角色卡 JSON 的 `model` 字段填写模型路径，例如：
- `models/haru/haru_greeter_t03.model3.json`（Live2D）
- `models/vrm/Alicia.vrm`（VRM）

或在设置面板的模型下拉菜单中选择。
