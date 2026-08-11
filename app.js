// ============================================================
// Live2D 桌宠 · 前端逻辑
// pixi-live2d-display 渲染 + 聊天 + 角色卡 + 语音
// ============================================================
(function () {
'use strict';

// Electron 环境下的 IPC（浏览器调试时不存在，容错）
let ipcRenderer = null;
try { if (typeof require !== 'undefined') ipcRenderer = require('electron').ipcRenderer; } catch (e) {}

/* ================= 状态 ================= */
let config = null;
let characters = [];
let activeCharName = '';
let activeSid = null;     // 当前活跃会话 id（与服务器 active 对齐）
let activeCharLabel = '搭子';
let activeCharModel = '';
let pixiApp = null;
let live2dModel = null;
let vrmAdapter = null;    // VRM 渲染适配器实例（VRMAdapter 类）
let activeModelType = ''; // 'live2d' | 'vrm' | ''（当前激活的模型类型）
let _dragDownPt = null;      // 拖拽起点（Live2D 和 VRM 共用）
let _dragDragging = false;   // 正在拖拽
let synthOn = false;
let pokeSpeakOn = true;  // 触摸身体是否触发大模型语音回复（设置里可关）
let touchCfg = null;     // 触摸手势配置（轻触/双击/长按 → 发给模型的词），由 loadConfig 载入

// 触摸动作默认词库：轻触 / 双击 / 长按 三类，按部位发送不同描述给模型
const DEFAULT_TOUCH = {
  holdMs: 500,   // 长按阈值（毫秒）：按住超过此值算“长按”
  doubleMs: 300, // 双击窗口（毫秒）：此窗口内同部位第二次点击算“双击”
  zones: []      // 默认无任何区域；触摸动作完全由用户在“触摸区域”里自定义，未匹配区域仅做动作
};
let ttsBusy = false;
let ttsQueue = [];       // TTS 播报队列：忙时排队，播完接着播（防丢句、防叠声）
let chatBusy = false;    // 聊天请求进行中（防并发乱序）
let chatQueue = [];      // 排队中的聊天内容：上一条回完再回下一条
let suppressSTT = false;
let zoomLevel = 1.6;   // 默认 160%：人物约占窗口高度 80%，接近拉满（可记忆持久化）
const ZOOM_MAX = 5.0;  // 最大 500%
let modelOriginW = 0;   // 模型原始宽度（width 会被 scale 污染，加载时保存）
let modelOriginH = 0;   // 模型原始高度
let modelLoadToken = 0; // 模型加载令牌：并发加载时只认最后一次，旧的直接作废（防切模型竞态）

// 自主小动作（idle 时随机动作/说话）
let idleAutoTimer = null;   // 空闲定时器
let idleBusy = false;       // 正在播自主动作（防叠播）
let lastActiveAt = 0;       // 最后一次用户互动时间戳
// 用户是否至少开口说过一次（没说过则不主动自言自语）；
// 只在内存记录，重启后归零 —— 设计意图：重启后必须先开口，AI 才恢复主动回复
let userEverSpoke = false;
let lastAutoAt = 0;         // 最后一次自主动作时间戳
let idleAnimEnabled = true; // 自主小动作总开关（可在设置里关）
// 视线跟随
let gazeTarget = { x: 0, y: 0 };   // 鼠标位置（窗口坐标）
let gazeEnabled = true;           // 总开关（ghostMode 下自动关）
const GAZE_MAX = 30;              // 眼珠最大偏移角度（度）
const AUTO_MIN_GAP = 12000;       // 两次自主动作最小间隔 12s
const AUTO_MAX_GAP = 35000;       // 最长 35s 内必有一次
const AUTO_IDLE_AFTER = 40000;    // 用户 40s 无互动视为空闲

/* ================= DOM ================= */
const $ = id => document.getElementById(id);
const statusEl = $('status');
const statusText = $('statusText');
const bubble = $('bubble');
const chatPanel = $('chatPanel');
const chatMsgs = $('chatMsgs');
const chatInput = $('chatInput');
const charPanel = $('charPanel');
const charList = $('charList');
const settingsPanel = $('settingsPanel');
const memPanel = $('memPanel');
const typing = $('typing');
const typingLbl = $('typingLbl');
const voiceState = $('voiceState');
const voiceRing = $('voiceRing');
const canvasWrap = $('canvas-wrap');

let bubbleTimer = null;

/* ================= 工具 ================= */
// 把气泡定位到模型头部左侧（屏幕坐标），增强带入感
function positionBubbleAtHead() {
  if (!pixiApp || !bubble) return;
  try {
    // VRM：适配镜头后模型居中，按画布比例估算头部位置
    if (activeModelType === 'vrm' && vrmAdapter) {
      const cv = document.getElementById('vrm-canvas');
      const rect = cv ? cv.getBoundingClientRect() : null;
      if (rect) {
        const headX = rect.width * 0.5;
        const headY = rect.height * 0.22;
        if (ipcRenderer) ipcRenderer.send('bubble-offset', { x: headX, y: headY });
        bubble.style.left = Math.max(8, rect.left + headX - rect.width * 0.35) + 'px';
        bubble.style.top = Math.max(8, rect.top + headY - 4) + 'px';
      }
      return;
    }
    if (!live2dModel) return;
    const mw = modelOriginW || live2dModel.width, mh = modelOriginH || live2dModel.height;
    const w = mw * live2dModel.scale.x, h = mh * live2dModel.scale.y;
    const headX = live2dModel.x + w * 0.5;   // 头部中心 x
    const headY = live2dModel.y + h * 0.12;  // 头部上缘 y
    // 上报头部相对窗口左上角的偏移，供主进程定位浮层窗口
    if (ipcRenderer) ipcRenderer.send('bubble-offset', { x: headX, y: headY });
    // 兼容：原窗内气泡（已隐藏）定位
    const rect = pixiApp.view.getBoundingClientRect();
    bubble.style.left = Math.max(8, rect.left + headX - w * 0.6) + 'px';
    bubble.style.top = Math.max(8, rect.top + headY - 4) + 'px';
  } catch (e) {}
}
function say(text, hold) {
  // 浮层气泡（可浮在宠物窗框外的桌面上）
  if (ipcRenderer && (live2dModel || activeModelType === 'vrm') && pixiApp) {
    try { ipcRenderer.send('bubble-show', { text, hold: hold || 3500 }); } catch (e) {}
  }
  bubble.textContent = text;
  positionBubbleAtHead();
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), hold || 3500);
}
function stripActionTags(text) {
  return String(text || '').replace(/[\[【][^\]】]{1,8}[\]】]/g, '').trim();
}
function setTyping(on, label) {
  typing.classList.toggle('on', on);
  if (label) typingLbl.textContent = label;
}
function addMsg(role, text, reasoning) {
  chatMsgs.appendChild(buildMsgEl(role === 'me' ? 'me' : 'her', text, null, true, reasoning));
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
}

// 构建一条消息元素（带删除按钮）
// idx: 在 allHistory 中的下标；noIndex: true 表示这条是即时渲染的（聊天中），删除时自动回退到 reload
function buildMsgEl(role, text, idx, noIndex, reasoning) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  // 思考过程（推理模型返回时才有）：折叠展示在正文上方
  if (reasoning && String(reasoning).trim()) {
    const det = document.createElement('details');
    det.className = 'thinking';
    const sum = document.createElement('summary');
    sum.textContent = '思考过程';
    const body = document.createElement('div');
    body.textContent = String(reasoning).trim();
    det.appendChild(sum);
    det.appendChild(body);
    d.appendChild(det);
  }
  const txt = document.createElement('span');
  txt.className = 'msg-txt';
  txt.textContent = text;
  const del = document.createElement('button');
  del.className = 'msg-del';
  del.title = '删除这条对话';
  del.textContent = '×';
  del.addEventListener('click', async () => {
    let realIdx = idx;
    if (noIndex) {
      // 即时消息：尝试在历史里按内容+角色定位
      realIdx = allHistory.findIndex(m => m.content === text && (m.role === 'user') === (role === 'me'));
      if (realIdx < 0) { alert('这条消息还没存进历史，刷新后再删'); return; }
    }
    if (!confirm('删除这条对话？删除后角色不会再记得它。')) return;
    try {
      const r = await fetch('/api/chat/message/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: realIdx })
      });
      const j = await r.json();
      if (j.ok) {
        // 删除后重新加载，保证剩余消息的索引正确
        allHistory = j.messages;
        chatMsgs.innerHTML = '';
        historyLoaded = 0;
        renderHistoryPage();
      }
      else alert('删除失败: ' + (j.error || ''));
    } catch (e) { alert('删除失败: ' + e.message); }
  });
  d.appendChild(txt);
  d.appendChild(del);
  return d;
}

/* ================= Live2D 渲染 ================= */
function initPixi() {
  try {
    pixiApp = new PIXI.Application({
      view: document.createElement('canvas'),
      backgroundAlpha: 0,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      antialias: true,
      preserveDrawingBuffer: true,
      width: window.innerWidth,
      height: window.innerHeight
    });
    canvasWrap.appendChild(pixiApp.view);
    pixiApp.view.style.width = '100%';
    pixiApp.view.style.height = '100%';
    pixiApp.view.style.position = 'absolute';
    pixiApp.view.style.top = '0';
    pixiApp.view.style.left = '0';
    pixiApp.view.style.pointerEvents = 'auto';

    window.addEventListener('resize', () => {
      if (pixiApp) {
        pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
        positionModel();
        try { positionBubbleAtHead(); } catch (e) {}
      }
      // VRM canvas 也跟随 resize
      if (vrmAdapter) {
        vrmAdapter.resize(window.innerWidth, window.innerHeight);
      }
    });
    return true;
  } catch (e) {
    statusText.textContent = 'PIXI 初始化失败: ' + e.message;
    return false;
  }
}

// 点击人物互动（hit 区域或包围盒兜底都走这里）
// 部位中文映射（Cubism HitArea 常见命名）
const HIT_PART_CN = {
  Head: '头', HeadL: '头', HeadR: '头', Face: '脸',
  Body: '身体', BodyL: '左身', BodyR: '右身', Chest: '胸口', Breast: '胸口',
  ArmL: '左手', ArmR: '右手', HandL: '左手', HandR: '右手',
  LegL: '左腿', LegR: '右腿', FootL: '左脚', FootR: '右脚',
  Tail: '尾巴', Wing: '翅膀'
};
let lastPokeAt = 0; // 戳身体节流时间戳

// 从 hitAreas 名称解析部位（有 HitArea 的模型走这）
function resolvePartFromHit(hitAreas) {
  if (Array.isArray(hitAreas) && hitAreas.length) {
    for (const a of hitAreas) {
      const cn = HIT_PART_CN[String(a).trim()];
      if (cn) return cn;
    }
    return String(hitAreas[0]); // 未知部位名原样返回（如 "Part1"）
  }
  return null;
}
// 从无 HitArea 模型的点击坐标，按纵向比例判断部位（上=头/中=身体/下=腿）
function resolvePartFromBox(e) {
  if (!live2dModel || !pixiApp) return null;
  const rect = pixiApp.view.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const mw = modelOriginW || live2dModel.width, mh = modelOriginH || live2dModel.height;
  const w = mw * live2dModel.scale.x, h = mh * live2dModel.scale.y;
  const mx = live2dModel.x, my = live2dModel.y;
  if (x < mx || x > mx + w || y < my || y > my + h) return null; // 点在模型外
  const ry = (y - my) / h;
  return ry < 0.33 ? '头' : ry < 0.7 ? '身体' : '腿';
}
// ===== 触摸手势：轻触 / 双击 / 长按，按部位发不同词给模型 =====
let pokeDown = null;        // 按下状态 { part, key, t, x, y }
let lastTap = { key: null, t: 0 };
let pendingTapTimer = null; // 单击延迟提交定时器（给双击留判定窗口）
const POKE_MOVE_TOL = 12;   // 按下到松手移动超过此像素数视为拖动，不算戳

// 把中文部位名归一为配置键（head/face/body/leftHand/rightHand/leg/tail/wing/other）
function normalizePart(part) {
  if (!part) return 'other';
  const m = {
    '头': 'head', '脸': 'face', '身体': 'body', '左身': 'body', '右身': 'body', '胸口': 'body',
    '左腿': 'leg', '右腿': 'leg', '腿': 'leg', '左脚': 'leg', '右脚': 'leg',
    '左手': 'leftHand', '右手': 'rightHand', '尾巴': 'tail', '翅膀': 'wing'
  };
  return m[part] || 'other';
}

// 命中检测：优先匹配用户自定义触摸区域(touchCfg.zones)，再回退模型 HitArea / 包围盒
function hitTestPart(e) {
  if (!pixiApp) return null;
  // 自定义区域：归一化到窗口 (0..1)，按宽高比校正成各向同性，避免非正方形窗口下圆变椭圆
  const nx = e.clientX / window.innerWidth;
  const ny = e.clientY / window.innerHeight;
  const aspect = window.innerHeight / window.innerWidth;
  const zones = (touchCfg && touchCfg.zones && Array.isArray(touchCfg.zones)) ? touchCfg.zones : [];
  let best = null, bestDist = Infinity;
  for (const z of zones) {
    if (typeof z.x !== 'number' || typeof z.y !== 'number' || typeof z.r !== 'number') continue;
    const dx = nx - z.x, dy = (ny - z.y) * aspect;
    const d = Math.hypot(dx, dy);
    if (d <= z.r && d < bestDist) { bestDist = d; best = z; }
  }
  if (best) {
    const part = best.name || best.part || '其他';
    return { part, key: best, zone: best }; // 区域用自身对象做去重键，避免不同自定义部位被误判为同一次双击
  }
  // 回退：模型自带 HitArea（精确），无则用包围盒纵向比例兜底
  if (!live2dModel) {
    // VRM 无 HitArea：按画布纵向比例粗略分部位
    if (activeModelType === 'vrm') {
      const cv = document.getElementById('vrm-canvas');
      const rect = cv ? cv.getBoundingClientRect() : null;
      if (rect && rect.height > 0) {
        const ratio = (e.clientY - rect.top) / rect.height;
        const part = ratio < 0.3 ? 'head' : ratio < 0.7 ? 'body' : 'leg';
        return { part, key: part, zone: null };
      }
    }
    return null;
  }
  const rect = pixiApp.view.getBoundingClientRect();
  const gx = e.clientX - rect.left, gy = e.clientY - rect.top;
  let names = [];
  try { names = live2dModel.hitTest(gx, gy) || []; } catch (err) {}
  let part = resolvePartFromHit(names);
  if (!part) part = resolvePartFromBox(e);
  return part ? { part, key: normalizePart(part), zone: null } : null;
}

function onPokePointerDown(e) {
  if (ghostMode) return;
  if (e.button !== undefined && e.button !== 0) return; // 仅左键
  const hit = hitTestPart(e);
  if (!hit) { pokeDown = null; return; }
  pokeDown = { part: hit.part, key: hit.key, zone: hit.zone, t: Date.now(), x: e.clientX, y: e.clientY };
}

function onPokePointerUp(e) {
  if (!pokeDown) return;
  const down = pokeDown; pokeDown = null;
  if (ghostMode) return;
  if (_dragDragging) return; // 刚拖完窗口松手，不算戳身体
  // 移动过多视为拖动窗口/拖模型，不算戳
  const ux = (e.clientX !== undefined) ? e.clientX : down.x;
  const uy = (e.clientY !== undefined) ? e.clientY : down.y;
  if (Math.hypot(ux - down.x, uy - down.y) > POKE_MOVE_TOL) return;
  const cfg = (touchCfg && typeof touchCfg === 'object') ? touchCfg : DEFAULT_TOUCH;
  const holdMs = Number(cfg.holdMs) || 500;
  const doubleMs = Number(cfg.doubleMs) || 300;
  const dur = Date.now() - down.t;
  let kind; // 'hold' | 'double' | 'tap'
  if (dur >= holdMs) {
    kind = 'hold';
  } else if (lastTap.key === down.key && (Date.now() - lastTap.t) <= doubleMs) {
    kind = 'double';
    lastTap = { key: null, t: 0 };
    if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
  } else {
    kind = 'tap';
    lastTap = { key: down.key, t: Date.now() };
  }
  commitPoke(down.part, down.key, kind, cfg, doubleMs, down.zone);
}

function onPokePointerCancel() { pokeDown = null; }

// 单击延迟提交（等 doubleMs 看是否变成双击）；双击/长按立即提交
function commitPoke(part, key, kind, cfg, doubleMs, zone) {
  const fire = () => doPokeSpeak(part, key, kind, cfg, zone);
  if (kind === 'tap') {
    if (pendingTapTimer) clearTimeout(pendingTapTimer);
    pendingTapTimer = setTimeout(fire, doubleMs);
  } else {
    if (pendingTapTimer) { clearTimeout(pendingTapTimer); pendingTapTimer = null; }
    fire();
  }
}

// 真正触发：按 部位 + 手势 选词，发给大模型（pokeSpeak 关闭时仅播动作）
function doPokeSpeak(part, key, kind, cfg, zone) {
  if (!pokeSpeakOn) { playRandomMotion(); return; } // 关闭触摸发语音：仅动作反馈
  const now = Date.now();
  if (now - lastPokeAt < 1500) return; // 1.5s 节流，防狂刷请求
  lastPokeAt = now;
  playRandomMotion(); // 即时动作反馈
  const word = pickPokeWord(key, kind, cfg, zone);
  chat('（你' + word + '）'); // 复用对话链路：大模型回复 + 气泡 + 动作 + 记录
}

// 选词优先级：自定义区域(zone)自带词 > 全局 touchCfg 的 prompts/doublePrompts/holdPrompts > 兜底
function pickPokeWord(key, kind, cfg, zone) {
  // 自定义区域：直接读该区域自己填的轻触/双击/长按短语（支持任意自定义部位名，如“辫子”）
  if (zone) {
    const zword = kind === 'hold' ? (zone.hold || zone.holdPrompts)
                : kind === 'double' ? (zone.double || zone.doublePrompts)
                : (zone.tap || zone.prompts);
    if (typeof zword === 'string' && zword.trim()) return zword.trim();
  }
  // 回退：全局 9 部位词表（按归一化键）
  const bucketName = kind === 'hold' ? 'holdPrompts' : kind === 'double' ? 'doublePrompts' : 'prompts';
  const bucket = (cfg && cfg[bucketName]) || (cfg && cfg.prompts);
  if (bucket && bucket[key]) return bucket[key];
  if (cfg && cfg.prompts && cfg.prompts[key]) return cfg.prompts[key];
  if (cfg && cfg.prompts && cfg.prompts.other) return cfg.prompts.other;
  return '戳了戳';
}

// 禁用模型缺失音效导致的报错：模型 model3.json 引用了不存在的 sounds/*.mp3，
// 库播放时 404 → 刷 [SoundManager] 错误。用空实现替换 soundManager，从源头消除（无真实音频可丢）
function silenceModelAudio() {
  try {
    const im = live2dModel && live2dModel.internalModel;
    if (!im) return;
    const mm = im.motionManager || im.motionManager;
    const sm = (mm && (mm.soundManager || mm._soundManager)) || live2dModel.soundManager;
    if (sm) {
      if (typeof sm.play === 'function') sm.play = function () {};
      if (typeof sm.stop === 'function') sm.stop = function () {};
    }
  } catch (e) {}
}

// 判断模型类型（根据文件扩展名）
function getModelType(modelPath) {
  if (!modelPath) return '';
  const ext = modelPath.split('.').pop().toLowerCase();
  if (ext === 'vrm' || ext === 'obj') return 'vrm'; // VRM 和 OBJ 都走 Three.js
  if (ext === 'json') return 'live2d'; // .model.json / .model3.json
  return '';
}

// 切换画布可见性
function showCanvas(type) {
  const l2dWrap = document.getElementById('canvas-wrap');
  const vrmWrap = document.getElementById('vrm-canvas-wrap');
  if (type === 'vrm') {
    if (l2dWrap) l2dWrap.style.display = 'none';
    if (vrmWrap) vrmWrap.style.display = 'block';
  } else {
    if (l2dWrap) l2dWrap.style.display = 'block';
    if (vrmWrap) vrmWrap.style.display = 'none';
  }
}

async function loadModel(modelPath) {
  if (!pixiApp) return;
  const token = ++modelLoadToken;   // 只认最后一次加载：旧的并发任务直接作废
  const path = modelPath || activeCharModel || 'models/assets/koharu.model.json';
  const modelType = getModelType(path);

  try {
    statusEl.classList.remove('hide');
    statusText.textContent = modelType === 'vrm' ? '加载 3D 模型…' : '加载模型…';

    if (modelType === 'vrm') {
      // ============ VRM 模型 ============
      // 清理 Live2D 模型
      if (live2dModel) {
        pixiApp.stage.removeChild(live2dModel);
        try { live2dModel.destroy(); } catch (e) {}
        live2dModel = null;
      }
      showCanvas('vrm');

      // 惰性初始化 VRMAdapter
      if (!vrmAdapter) {
        const canvas = document.getElementById('vrm-canvas');
        if (!canvas || !window.VRMAdapter) {
          statusText.textContent = 'VRM 适配器加载中…';
          // 等待 adapter 加载（最多 30 秒）
          await new Promise((resolve, reject) => {
            let waited = 0;
            const check = () => {
              if (window.VRMAdapter) { resolve(); return; }
              waited += 200;
              if (waited > 30000) {
                reject(new Error('VRM 适配器加载超时，请检查网络'));
                return;
              }
              setTimeout(check, 200);
            };
            check();
          });
        }
        if (token !== modelLoadToken) return; // 等待适配器期间已被切走
        const vrmCanvas = document.getElementById('vrm-canvas');
        vrmAdapter = new window.VRMAdapter(vrmCanvas);
      }

      await vrmAdapter.loadModel(path);
      if (token !== modelLoadToken) return; // 加载期间已被切走，作废本次结果
      activeModelType = 'vrm';
      modelOriginW = 0;
      modelOriginH = 0;
      // 强制隐藏加载状态
      statusEl.classList.add('hide');

      // 注册触摸事件（拖拽已在 setupBodyDrag 统一处理）
      const vrmCanvasEl = document.getElementById('vrm-canvas');
      if (vrmCanvasEl) {
        syncCanvasPointer();
        vrmCanvasEl.removeEventListener('pointerdown', onPokePointerDown);
        vrmCanvasEl.addEventListener('pointerdown', onPokePointerDown);
      }

    } else {
      // ============ Live2D 模型 ============
      // 清理 VRM
      if (vrmAdapter) {
        vrmAdapter.destroy();
      }
      // 关闭 VRM canvas 的交互
      const vrmCanvasEl2 = document.getElementById('vrm-canvas');
      if (vrmCanvasEl2) vrmCanvasEl2.style.pointerEvents = 'none';
      showCanvas('live2d');

      // 移除旧 Live2D 模型
      if (live2dModel) {
        pixiApp.stage.removeChild(live2dModel);
        try { live2dModel.destroy(); } catch (e) {}
        live2dModel = null;
      }

      const newModel = await PIXI.live2d.Live2DModel.from(path, { autoInteract: false });
      if (token !== modelLoadToken) {
        // 已切到其他模型：销毁本次加载的模型，避免覆盖新状态
        try { newModel.destroy(); } catch (e) {}
        return;
      }
      live2dModel = newModel;
      pixiApp.stage.addChild(live2dModel);
      silenceModelAudio();
      modelOriginW = live2dModel.width;
      modelOriginH = live2dModel.height;
      positionModel();
      // Live2D 画布交互状态（可拖/可点身体），透视/面板打开时统一由 syncCanvasPointer 管理穿透
      syncCanvasPointer();

      // 触摸互动
      if (typeof live2dModel.off === 'function') live2dModel.off('hit');
      pixiApp.view.removeEventListener('pointerdown', onPokePointerDown);
      pixiApp.view.addEventListener('pointerdown', onPokePointerDown);
      window.removeEventListener('pointerup', onPokePointerUp);
      window.addEventListener('pointerup', onPokePointerUp);
      window.removeEventListener('pointercancel', onPokePointerCancel);
      window.addEventListener('pointercancel', onPokePointerCancel);

      playRandomMotion();
      activeModelType = 'live2d';
    }

    // 模型加载完成后刷新触发配置的可用选项（动作/表情列表）
    try { refreshTriggerModelInfo(); } catch (e) {}
    try { renderTriggerList((config && config.motionTriggers) || []); } catch (e) {}
    pushModelActions();   // 主动推送可用列表给设置/角色窗口

    statusEl.classList.add('hide');
  } catch (e) {
    if (token !== modelLoadToken) return; // 过期任务的报错不覆盖当前状态
    statusText.textContent = '模型加载失败: ' + e.message;
    console.error('模型加载失败', e);
    // 3 秒后隐藏加载状态
    setTimeout(() => { try { statusEl.classList.add('hide'); } catch (e2) {} }, 3000);
  }
}

// 窗口“设计基准尺寸”：仅用于计算模型在 100% 缩放下占窗口的比例，窗口本身尺寸固定不变
const BASE_WIN_W = 520, BASE_WIN_H = 580;

function positionModel() {
  // VRM 模型：通过 adapter 的 setZoom 控制
  if (activeModelType === 'vrm' && vrmAdapter) {
    vrmAdapter.setZoom(zoomLevel);
    refreshLayout();
    return;
  }
  if (!live2dModel || !pixiApp) return;
  const w = pixiApp.renderer.width / (window.devicePixelRatio || 1);
  const h = pixiApp.renderer.height / (window.devicePixelRatio || 1);
  const mw = modelOriginW || live2dModel.width;
  const mh = modelOriginH || live2dModel.height;
  const FIT = 0.5;
  const scale = Math.min(w / mw, h / mh) * FIT * zoomLevel;
  live2dModel.scale.set(scale);
  live2dModel.x = w / 2 - (mw * scale) / 2;
  live2dModel.y = h / 2 - (mh * scale) / 2;
  refreshLayout();
}

// 刷新与人物相关的浮层布局：头顶拖拽锚点 + 对话气泡头部偏移
function refreshLayout() {
  setupBodyDrag();
  setupFrameResize();
  positionBubbleAtHead();
}

/* ================= 缩放 ================= */
function setZoom(level) {
  zoomLevel = Math.max(0.3, Math.min(ZOOM_MAX, level));
  try { if (ipcRenderer) ipcRenderer.send('zoom-state', Math.round(zoomLevel * 100)); } catch (e) {}
  // PIXI 未就绪（如 loadConfig 在 initPixi 前恢复缩放）时只记录缩放值、跳过渲染，
  // 渲染由 initPixi/loadModel 完成后的 positionModel 应用——避免提前触发布局刷新/拖拽绑定
  if (!pixiApp) return;
  // 仅缩放模型（以人物中心为锚点），窗口尺寸固定不变 —— 所以“框”恒定、不被顶飞、人物在框内放大
  positionModel();
  refreshLayout();
  // 持久化缩放比例（重启后保持）
  try {
    fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zoomLevel })
    }).catch(() => {});
  } catch (err) {}
}

// 缩放按钮已移至 dock.html 浮窗（发送 'zoom' IPC → 主进程 → 宠物窗执行）

// 透视按钮：开启后鼠标可穿透模型区域，操作后面的桌面文件
let ghostMode = false;
let ghostOpacity = 40;    // 透视时人物透明度（%）10~90
function applyGhostOpacity() {
  // 透明度只作用在人物画布（底栏已拆为独立浮窗 dock.html，不在此处理）
  const wrap = document.getElementById('canvas-wrap');
  const o = ghostMode ? (ghostOpacity / 100) : 1;
  if (wrap) wrap.style.opacity = o;
}
// 宠物窗面板内的透视透明度滑条：拖动实时预览（不落盘），松手才保存
(function bindGhostOpacityRange() {
  const go = document.getElementById('ghostOpacityRange');
  if (!go) return;
  go.addEventListener('input', () => {
    ghostOpacity = Math.max(10, Math.min(90, Number(go.value) || 40));
    const v = document.getElementById('ghostOpacityVal');
    if (v) v.textContent = ghostOpacity + '%';
    applyGhostOpacity();
  });
  go.addEventListener('change', async () => {
    try {
      await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ghostOpacity: Number(go.value) }) });
    } catch (e) {}
  });
})();
function setGhostMode(v) {
  ghostMode = v;
  syncCanvasPointer();
  applyGhostOpacity();
  // VRM idle 动画：透视模式下暂停（省资源 + 不干扰穿透操作）
  if (vrmAdapter) vrmAdapter.setIdleEnabled(!ghostMode);
  const panelOpen = document.body.classList.contains('panel-open');
  try { ipcRenderer.send('set-ignore-mouse', ghostMode && !panelOpen); } catch (e) {}
  try { ipcRenderer.send('ghost-state', ghostMode); } catch (e) {}
}

// dock 拖动已移至 dock.html 独立浮窗，由主进程 IPC 处理（dock-drag-start/move/end）

// ===== 拖动宠物：按住人物身体拖动（Live2D 和 VRM canvas 统一逻辑）=====
let bodyDragReady = false;
function setupBodyDrag() {
  if (!ipcRenderer) return;

  // 统一的拖拽状态（全局，两个 canvas 共用）
  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;   // 仅左键
    _dragDownPt = { x: e.clientX, y: e.clientY };
    _dragDragging = false;
  };

  // Live2D canvas：pixiApp.view 未就绪时先跳过（initPixi 之后再次调用本函数会补绑）；
  // 每次调用都先解绑再绑，保证最终一定绑上，避免"过早调用被 bodyDragReady 挡掉"导致永远拖不动
  if (pixiApp && pixiApp.view) {
    pixiApp.view.removeEventListener('pointerdown', onDown);
    pixiApp.view.addEventListener('pointerdown', onDown);
  }
  // VRM canvas
  const vrmCanvas = document.getElementById('vrm-canvas');
  if (vrmCanvas) {
    vrmCanvas.removeEventListener('pointerdown', onDown);
    vrmCanvas.addEventListener('pointerdown', onDown);
  }

  // window 级监听只绑一次（拖动判定是窗口级的，不依赖 canvas 是否就绪）
  if (bodyDragReady) return;
  bodyDragReady = true;

  window.addEventListener('pointermove', (e) => {
    if (!_dragDownPt) return;
    if (!_dragDragging && Math.hypot(e.clientX - _dragDownPt.x, e.clientY - _dragDownPt.y) > POKE_MOVE_TOL) {
      _dragDragging = true;
      try { ipcRenderer.send('drag-start'); } catch (err) {}
    }
    if (_dragDragging) { try { ipcRenderer.send('drag-move'); } catch (err) {} }
  });
  window.addEventListener('pointerup', () => {
    if (_dragDragging) { try { ipcRenderer.send('drag-end'); } catch (err) {} }
    _dragDragging = false; _dragDownPt = null;
  });
  window.addEventListener('pointercancel', () => { _dragDragging = false; _dragDownPt = null; });
}

// ===== 缩放窗口：拖动虚线框边缘/角（人物随框自适应） =====
let frameResizeReady = false;
function setupFrameResize() {
  if (frameResizeReady || !ipcRenderer) return;
  const frame = document.getElementById('frame');
  if (!frame) return;
  frameResizeReady = true;
  let active = null;   // { anchor, sx, sy }
  frame.querySelectorAll('.rh').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      active = { anchor: h.getAttribute('data-anchor'), sx: e.clientX, sy: e.clientY };
      try { ipcRenderer.send('resize-start', active.anchor); } catch (err) {}
    });
  });
  window.addEventListener('pointermove', (e) => {
    if (!active) return;
    try { ipcRenderer.send('resize-move', e.clientX - active.sx, e.clientY - active.sy); } catch (err) {}
  });
  window.addEventListener('pointerup', () => {
    if (active) { active = null; try { ipcRenderer.send('resize-end'); } catch (err) {} }
  });
  window.addEventListener('pointercancel', () => { active = null; });
}

// 滚轮缩放（在画布上滚动）
canvasWrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.05 : 0.05;
  setZoom(zoomLevel + delta);
}, { passive: false });

// IPC：接收主进程的缩放指令
if (ipcRenderer) {
  ipcRenderer.on('zoom', (e, delta) => setZoom(zoomLevel + delta));
  ipcRenderer.on('zoom-reset', () => setZoom(1.0));
  ipcRenderer.on('toggle-panel', () => {
    const anyOpen = panels.some(p => p.classList.contains('show'));
    if (anyOpen) {
      panels.forEach((p, i) => { p.classList.remove('show'); if (panelBtns[i]) panelBtns[i].classList.remove('active'); });
      document.body.classList.remove('panel-open');
      syncCanvasPointer(); // 关闭面板立即恢复画布交互
      // 面板关闭后，若仍处透视模式，恢复穿透
      try { if (ghostMode) ipcRenderer.send('set-ignore-mouse', true); } catch (e) {}
    } else {
      togglePanel(chatPanel, null);
    }
  });
  // 底栏浮窗的透视按钮 → 由主进程转发到这里执行
  ipcRenderer.on('ghost-toggle', () => {
    setGhostMode(!ghostMode);
    if (ghostMode) say('透视模式已开，鼠标可以点到后面啦');
    else say('透视模式已关');
  });
  // 主进程（托盘菜单）强制退出透视
  ipcRenderer.on('ghost-off', () => { if (ghostMode) setGhostMode(false); });
  // 设置窗口改了配置 → 重新载入 config 实时生效
  ipcRenderer.on('reload-config', () => { loadConfig(); });
  // 设置窗口拖动透视透明度滑条 → 实时预览（不落盘，松手后由 change→POST 保存并触发 reload-config）
  ipcRenderer.on('ghost-opacity', (e, v) => {
    ghostOpacity = Math.max(10, Math.min(90, Number(v) || 40));
    applyGhostOpacity();
  });
  // 小动作开关变更
  ipcRenderer.on('idle-anim-changed', (e, on) => {
    idleAnimEnabled = !!on;
    if (vrmAdapter) vrmAdapter.setIdleEnabled(!!on);
  });
  // 宠物窗内设置面板：触摸身体发语音开关（dock 打开的 settings.html 是主入口，这里作为兜底）
  const psTogEl = $('pokeSpeakTog');
  if (psTogEl) psTogEl.addEventListener('click', async () => {
    const newVal = !pokeSpeakOn;
    try {
      const r = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pokeSpeak: newVal })
      });
      if ((await r.json()).ok) { pokeSpeakOn = newVal; psTogEl.classList.toggle('on', newVal); }
    } catch (e) {}
  });
  // 宠物窗内设置面板：自动找话题开关 + 延迟/次数滑条（兜底，主入口在 settings.html）
  const arTogEl = $('autoReplyTog');
  if (arTogEl) arTogEl.addEventListener('click', async () => {
    const newVal = !autoReplyOn;
    try {
      const r = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoReply: newVal })
      });
      if ((await r.json()).ok) {
        autoReplyOn = newVal;
        arTogEl.classList.toggle('on', newVal);
        const cfg = $('autoReplyCfg');
        if (cfg) cfg.style.display = newVal ? '' : 'none';
      }
    } catch (e) {}
  });
  const arDelayEl = $('arDelayRange');
  if (arDelayEl) {
    arDelayEl.addEventListener('input', () => {
      const v = arDelayEl.value;
      const lbl = $('arDelayVal');
      if (lbl) lbl.textContent = v;
    });
    arDelayEl.addEventListener('change', async () => {
      const v = Number(arDelayEl.value);
      autoReplyDelayMs = Math.max(5000, v * 1000);
      try {
        await fetch('/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoReplyDelay: v })
        });
      } catch (e) {}
    });
  }
  const arMaxCntEl = $('arMaxCountRange');
  if (arMaxCntEl) {
    arMaxCntEl.addEventListener('input', () => {
      const v = Number(arMaxCntEl.value);
      const lbl = $('arMaxCountVal');
      if (lbl) lbl.textContent = (v > 0 ? v : '∞');
    });
    arMaxCntEl.addEventListener('change', async () => {
      const v = Number(arMaxCntEl.value);
      autoReplyMaxCount = Math.max(0, v);
      try {
        await fetch('/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoReplyMaxCount: v })
        });
      } catch (e) {}
    });
  }
  // win-state 现已发送给 dock.html 浮窗，宠物窗无需处理
  // settings/characters 改模型 / 切角色后即时重载
  // 关键修复：先重新从服务器同步活跃角色，根治"宠物窗 activeCharName 陈旧"导致模型/聊天不跟随切换
  ipcRenderer.on('reload-model', async () => {
    try {
      await loadCharacters();                 // 重新同步 activeCharName / activeCharModel（来自服务器最新 active）
      await syncActiveSession();              // 切角色后回到该角色首个会话
      if (activeCharModel) await loadModel(activeCharModel);
      else await loadModel('');
      // 角色/模型已变：重新拉取配置（动作/表情触发配置按角色个性化）
      await loadConfig();
      pushModelActions();                     // 通知设置/角色窗口刷新可用列表与保存列表
      // 同步刷新宠物窗自身的聊天记录
      if (chatMsgs) {
        chatMsgs.innerHTML = '';
        historyLoaded = 0;
        await loadChatHistory();
      }
    } catch (e) {}
  });

  // 聊天窗切换会话：同步宠物窗活跃会话 id，并重载自身聊天记录/记忆面板
  ipcRenderer.on('session-changed', async (e, sid) => {
    try {
      activeSid = sid || null;
      await syncActiveSession();
      if (chatMsgs) { chatMsgs.innerHTML = ''; historyLoaded = 0; await loadChatHistory(); }
      if (memPanel && memPanel.classList.contains('show')) loadMemPanel();
    } catch (err) {}
  });

}

/* ================= 动作/表情 ================= */
const MOTION_MAP = {
  '挥手': ['wave', 'Wave', 'idle', 'Idle', 'tap_body', 'TapBody'],
  '招手': ['wave', 'Wave', 'idle', 'Idle'],
  '点头': ['nod', 'Nod', 'yes', 'Yes', 'idle', 'Idle'],
  '歪头': ['tilt', 'Tilt', 'think', 'Think', 'idle', 'Idle'],
  '摇头': ['shake', 'Shake', 'no', 'No', 'deny', 'Deny'],
  '跳舞': ['dance', 'Dance', 'happy', 'Happy', 'tap_body', 'TapBody'],
  '开心': ['happy', 'Happy', 'smile', 'Smile', 'tap_body', 'TapBody'],
  '高兴': ['happy', 'Happy', 'tap_body', 'TapBody'],
  '兴奋': ['excited', 'Excited', 'happy', 'Happy'],
  '惊讶': ['surprised', 'Surprised', 'shock', 'Shock', 'tap_body', 'TapBody'],
  '震惊': ['surprised', 'Surprised', 'shock', 'Shock'],
  '害羞': ['shy', 'Shy', 'embarrassed', 'Embarrassed', 'tap_body', 'TapBody'],
  '生气': ['angry', 'Angry', 'mad', 'Mad', 'tap_body', 'TapBody'],
  '比心': ['heart', 'Heart', 'love', 'Love', 'happy', 'Happy'],
  '心': ['heart', 'Heart', 'love', 'Love'],
};

function getMotionGroups() {
  // VRM 模型：返回程序化动作名
  if (activeModelType === 'vrm' && vrmAdapter) {
    return vrmAdapter.getMotionGroups();
  }
  if (!live2dModel) return [];
  try {
    const internal = live2dModel.internalModel;
    const motionManager = internal?.motionManager;
    if (motionManager?.definitions) {
      return Object.keys(motionManager.definitions);
    }
  } catch (e) {}
  return [];
}

// 获取空分组（""）下的动作文件名列表，用于游戏提取模型（如碧蓝航线）的语义匹配
function getUngroupedMotionNames() {
  if (!live2dModel) return [];
  try {
    const internal = live2dModel.internalModel;
    const motionManager = internal?.motionManager;
    if (motionManager?.definitions && motionManager.definitions['']) {
      return motionManager.definitions[''].map(d => {
        const f = (d.file || d.File || '').toLowerCase();
        return f.split('/').pop().replace(/\.(motion3\.json|mtn)$/, '');
      }).filter(Boolean);
    }
  } catch (e) {}
  return [];
}

// 空分组模型：情绪 -> 文件名关键词（碧蓝航线 z23 等游戏提取模型）
const UNGROUPED_MOTION_KEYWORDS = {
  '挥手': ['home', 'login'],
  '招手': ['home', 'login'],
  '点头': ['main_1', 'main1'],
  '歪头': ['main_2', 'main2', 'think'],
  '摇头': ['mission'],
  '跳舞': ['login', 'complete'],
  '开心': ['complete', 'mission_complete', 'missioncomplete'],
  '高兴': ['complete', 'mission_complete'],
  '兴奋': ['login', 'complete'],
  '惊讶': ['main_3', 'main3'],
  '震惊': ['main_3', 'main3'],
  '害羞': ['touch_special', 'touchspecial', 'special'],
  '生气': ['mail'],
  '比心': ['wedding'],
  '心': ['wedding'],
  '触摸': ['touch_head', 'touchhead', 'touch_body', 'touchbody'],
};

function getExpressionNames() {
  // VRM 模型：返回 VRM 标准表情名
  if (activeModelType === 'vrm' && vrmAdapter) {
    return vrmAdapter.getExpressionNames();
  }
  if (!live2dModel) return [];
  try {
    const internal = live2dModel.internalModel;
    const motionManager = internal?.motionManager;
    if (motionManager?.expressionManager?.definitions) {
      return Object.keys(motionManager.expressionManager.definitions);
    }
  } catch (e) {}
  return [];
}

function playMotion(name) {
  // VRM 模型：委托给 adapter
  if (activeModelType === 'vrm' && vrmAdapter) {
    return vrmAdapter.playMotion(name);
  }
  if (!live2dModel) return false;
  const groups = getMotionGroups();
  const candidates = MOTION_MAP[name] || [name, name.toLowerCase(), name.toUpperCase()];
  for (const g of candidates) {
    if (groups.includes(g)) {
      try {
        live2dModel.motion(g);
        return true;
      } catch (e) {}
    }
    // 模糊匹配
    const found = groups.find(grp => grp.toLowerCase() === g.toLowerCase());
    if (found) {
      try { live2dModel.motion(found); return true; } catch (e) {}
    }
  }
  // 空分组模型：按文件名关键词匹配（碧蓝航线等游戏提取模型）
  const motionNames = getUngroupedMotionNames();
  if (motionNames.length) {
    const kws = UNGROUPED_MOTION_KEYWORDS[name] || [name.toLowerCase()];
    for (const kw of kws) {
      const hit = motionNames.find(n => n.includes(kw));
      if (hit) {
        try {
          live2dModel.motion('');
          // 指定具体动作：通过 startMotion 精确播放
          const internal = live2dModel.internalModel?.motionManager;
          const idx = internal?.definitions?.['']?.findIndex(d => (d.file || '').toLowerCase().includes(kw));
          if (idx >= 0) { internal.startMotion('', idx); return true; }
          return true;
        } catch (e) {}
      }
    }
    // 兜底：空组随机播一个
    if (name && candidates.length) {
      try { live2dModel.motion(''); return true; } catch (e) {}
    }
  }
  return false;
}

function playExpression(name) {
  // VRM 模型：委托给 adapter
  if (activeModelType === 'vrm' && vrmAdapter) {
    return vrmAdapter.playExpression(name);
  }
  if (!live2dModel) return false;
  const exps = getExpressionNames();
  if (!exps.length) return false;
  const candidates = [name, name.toLowerCase(), name.toUpperCase()];
  for (const c of candidates) {
    if (exps.includes(c)) { try { live2dModel.expression(c); return true; } catch (e) {} }
    const found = exps.find(e => e.toLowerCase() === c.toLowerCase());
    if (found) { try { live2dModel.expression(found); return true; } catch (e) {} }
  }
  return false;
}

function playRandomMotion() {
  // VRM 模型：播一个 nod 作为默认动作
  if (activeModelType === 'vrm' && vrmAdapter) {
    vrmAdapter.playMotion('nod');
    return;
  }
  if (!live2dModel) return;
  const groups = getMotionGroups();
  if (!groups.length) return;
  // 优先 idle/Idle
  const idle = groups.find(g => g.toLowerCase().includes('idle'));
  const target = idle || groups[Math.floor(Math.random() * groups.length)];
  try { live2dModel.motion(target); } catch (e) {}
  // 空分组模型：优先按文件名找 idle
  const motionNames = getUngroupedMotionNames();
  if (motionNames.length) {
    const idleName = motionNames.find(n => n.includes('idle'));
    if (idleName) {
      const internal = live2dModel.internalModel?.motionManager;
      const idx = internal?.definitions?.['']?.findIndex(d => (d.file || '').toLowerCase().includes('idle'));
      if (idx >= 0) { try { internal.startMotion('', idx); } catch (e) {} }
    }
  }
}

/* ================ 自主小动作 + 视线跟随 ================ */

// 记录用户互动时间（鼠标/点击/说话），供空闲判定用
function markActive() {
  lastActiveAt = Date.now();
}

// 用户真正回话了：重置连续开口计数，恢复自主找话题
function onUserReplied() {
  markActive();
  userEverSpoke = true;     // 用户回话了：允许后续主动开口
  initiativeCount = 0;
  initiativeStopped = false;
}

// 视线跟随：鼠标位置 -> 眼珠参数（ParamAngleX/Y），在渲染循环里调用
// 注意：Cubism 4 core 用 getParameterIndex + setParameterValueByIndex，不能直接操作 core.parameters
// 坐标来源：主进程全局鼠标轮询（IPC 'gaze'，屏幕坐标转窗口坐标），全屏任意位置都跟随，透视模式也跟随
function updateGaze() {
  if (!gazeEnabled) return;

  const wx = window.innerWidth || 1;
  const wy = window.innerHeight || 1;
  const nx = Math.max(-1, Math.min(1, (gazeTarget.x / wx) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, (gazeTarget.y / wy) * 2 - 1));

  // VRM 模型：直接传归一化坐标给 adapter
  if (activeModelType === 'vrm' && vrmAdapter) {
    vrmAdapter.setGaze(nx, ny);
    return;
  }

  // Live2D 模型
  if (!live2dModel || !pixiApp) return;
  const core = live2dModel.internalModel?.coreModel;
  if (!core) return;
  // 一次性诊断：确认参数可寻址（只打一次，避免刷屏）
  if (!window.__gazeDiagDone) {
    window.__gazeDiagDone = true;
    try {
      const ax = core.getParameterIndex('ParamAngleX');
      const ay = core.getParameterIndex('ParamAngleY');
      const ebx = core.getParameterIndex('ParamEyeBallX');
      console.log('[gaze-diag] ParamAngleX=' + ax + ' ParamAngleY=' + ay + ' ParamEyeBallX=' + ebx);
      if (ax >= 0) {
        console.log('[gaze-diag] AngleX range=' + core._model.parameters.minimumValues[ax] + '~' + core._model.parameters.maximumValues[ax]);
      }
      if (ay >= 0) {
        console.log('[gaze-diag] AngleY range=' + core._model.parameters.minimumValues[ay] + '~' + core._model.parameters.maximumValues[ay]);
      }
    } catch (e) { console.log('[gaze-diag] err ' + e.message); }
  }
  // nx/ny 已在外层计算
  // 直接 set 会被 motion 覆盖，所以策略：set 一个基础值 + 每帧在基础上 add 偏移量
  // 但 set 会被 motion 拉回，所以改成：每帧都 set（覆盖 motion），保证最终值就是我们想要的
  const setParam = (id, v) => {
    try {
      const idx = core.getParameterIndex(id);
      if (idx >= 0) core.setParameterValueByIndex(idx, v, 1);
    } catch (e) {}
  };
  setParam('ParamAngleX', nx * GAZE_MAX);
  // 屏幕 y 向下为正：鼠标在下方 → ny 为正 → 应低头（ParamAngleY 正值=低头），但用户反馈反向，取反
  setParam('ParamAngleY', -ny * GAZE_MAX * 0.8);
  setParam('ParamBodyAngleX', nx * GAZE_MAX * 0.4);
  setParam('ParamBodyAngleY', -ny * GAZE_MAX * 0.3);
  // 眼珠单独偏移（部分模型用 ParamEyeBallX/Y 而不是头转）
  setParam('ParamEyeBallX', nx * 40);
  setParam('ParamEyeBallY', -ny * 25);
}

// 自主小动作：空闲时随机播一个非 idle 动作，偶尔冒一句小话
// 说话走独立的小气泡（不写聊天历史），避免污染对话记录
const AUTO_LINES = [
  '（伸了个懒腰）', '（打了个哈欠）', '（歪头看你）', '（托腮发呆）',
  '（小声嘀咕）', '（站起来活动一下）', '（揉了揉眼睛）', '（看向窗外）'
];
let lastAutoLineIdx = -1;
function autoRandomMotion() {
  if (!live2dModel || idleBusy || ghostMode) return;
  const groups = getMotionGroups();
  const motionNames = getUngroupedMotionNames();
  // 随机挑一个“非 idle”动作，制造“活气”
  const pool = groups.filter(g => !g.toLowerCase().includes('idle'));
  const unPool = motionNames.filter(n => !n.includes('idle'));
  const candidates = [];
  for (const g of pool) candidates.push({ type: 'group', name: g });
  for (const n of unPool) candidates.push({ type: 'file', name: n });
  if (candidates.length) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    idleBusy = true;
    try {
      if (pick.type === 'group') {
        live2dModel.motion(pick.name);
      } else {
        // 空分组：按文件名直接 startMotion
        const internal = live2dModel.internalModel?.motionManager;
        const idx = internal?.definitions?.['']?.findIndex(d => (d.file || '').includes(pick.name));
        if (idx >= 0) internal.startMotion('', idx);
      }
    } catch (e) {}
    // 动作播完（约 3 秒）解锁
    setTimeout(() => { idleBusy = false; }, 3000);
  }
  // 偶尔冒一句小话（30% 概率）：模型没有非 idle 动作时，嘀咕就是唯一的小动作表现
  if (Math.random() < 0.3) {
    let li = Math.floor(Math.random() * AUTO_LINES.length);
    if (li === lastAutoLineIdx) li = (li + 1) % AUTO_LINES.length;
    lastAutoLineIdx = li;
    say(AUTO_LINES[li], 2500);
  }
}

// 自主找话题：空闲超过阈值时角色主动开口（调用服务器 initiative 接口）
let initiativeRunning = false;
let lastInitiativeAt = 0;
let initiativeCount = 0;      // 连续主动开口计数（用户不回话时累计）
let initiativeStopped = false; // 发满上限后停止，等用户回话再恢复
let autoReplyOn = true;        // 自动找话题总开关（设置面板可关）
let autoReplyDelayMs = 40000;  // 用户无互动多少毫秒后角色主动开口（从配置读取，默认40s）
let autoReplyMaxCount = 5;     // 连续主动开口最多几次（从配置读取，0=不限制）
async function autoInitiative() {
  if (!autoReplyOn) return;  // 开关关闭：不主动开口
  if (!userEverSpoke) return; // 用户从未开口过：不自言自语（启动后必须用户先说话才主动回复）
  if (initiativeRunning || ghostMode || initiativeStopped) return;
  if (chatBusy) return; // 对话进行中不抢话，等下个周期再试
  const now = Date.now();
  // 两次主动开口最小间隔 = 延迟时间本身（她说完一句后等同样久再决定是否继续）
  if (now - lastInitiativeAt < autoReplyDelayMs) return;
  if (now - lastActiveAt < autoReplyDelayMs) return;  // 用户还在互动，不打扰
  initiativeRunning = true;
  try {
    const r = await fetch('/api/chat/initiative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeSid })
    });
    const data = await r.json();
    if (data.error) return;
    const reply = (data.reply || '').trim();
    if (!reply) return;
    lastInitiativeAt = now;
    initiativeCount++;
    // 先保证气泡/动作/语音一定出现（关键：即便聊天框插入异常也不影响“主动开口”本身）
    playMotionFromText(reply);
    say(stripActionTags(reply), 4500);
    if (synthOn) speak(reply);
    // 聊天记录插入（容错：单条失败不影响整体与下一次触发）
    try {
      allHistory.push({ role: 'assistant', content: reply });
      historyLoaded = Math.min(allHistory.length, historyLoaded + 1);
    } catch (e) {}
    try { addMsg('her', reply); } catch (e) {}
    // 发满上限：停止主动开口，等用户回话再恢复
    if (autoReplyMaxCount > 0 && initiativeCount >= autoReplyMaxCount) {
      initiativeStopped = true;
      setTimeout(() => { try { say('（先说到这，你回来我再继续~）', 3000); } catch (e) {} }, 2500);
    }
  } catch (e) {
    // 失败静默，下个周期再试
  } finally {
    initiativeRunning = false;
  }
}

// 主空闲调度：每隔几秒检查一次
async function idleScheduler() {
  // 实时同步“自动找话题”设置：无论在哪（设置窗口/迷你面板）改了滑块，
  // 宠物窗都在下一个周期生效，不用重启。（之前改了只写盘、运行实例读不到旧值，
  // 导致“设几次都不变”——宠物窗一直用启动时的旧值）
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    if (cfg && typeof cfg === 'object') {
      autoReplyDelayMs = Math.max(5000, (Number(cfg.autoReplyDelay) || 40) * 1000);
      autoReplyMaxCount = Math.max(0, Number(cfg.autoReplyMaxCount) || 0);
    }
  } catch (e) {}
  const now = Date.now();
  const idleMs = now - lastActiveAt;
  // 1) 自主找话题：独立开关（autoReplyOn），不再受“小动作”开关影响
  if (autoReplyOn && !ghostMode) {
    if (idleMs > autoReplyDelayMs) {
      autoInitiative();
    }
  }
  // 2) 自主小动作：受“小动作”开关控制
  if (idleAnimEnabled && idleMs > AUTO_IDLE_AFTER && now - lastAutoAt > AUTO_MIN_GAP + Math.random() * (AUTO_MAX_GAP - AUTO_MIN_GAP)) {
    autoRandomMotion();
    lastAutoAt = now;
  }
}

// 启动自主功能（boot 末尾调用）
function startAutoLife() {
  if (idleAutoTimer) clearInterval(idleAutoTimer);
  lastActiveAt = Date.now();
  idleAutoTimer = setInterval(idleScheduler, 8000);
  // 视线跟随：挂到 pixi ticker（每帧刷新眼珠）
  if (pixiApp && !pixiApp.ticker._live2dGaze) {
    pixiApp.ticker.add(() => updateGaze());
    pixiApp.ticker._live2dGaze = true;
  }
  // 监听鼠标移动更新目标位置（窗口内 mousemove，仅当主进程轮询不可用时兜底）
  // 注意：这里不调 markActive()——鼠标从透明悬浮窗上划过不能算“用户互动”，
  // 否则 lastActiveAt 被高频刷新，空闲判定永远不满足，自主小动作永不触发
  window.addEventListener('mousemove', e => {
    gazeTarget.x = e.clientX;
    gazeTarget.y = e.clientY;
  });
  // 主进程全局鼠标轮询（全屏跟随）：屏幕坐标已转为窗口内坐标
  try {
    ipcRenderer.on('gaze', (ev, pos) => {
      if (pos && typeof pos.x === 'number') {
        gazeTarget.x = pos.x;
        gazeTarget.y = pos.y;
      }
    });
  } catch (e) {}
  window.addEventListener('pointerdown', markActive);
  window.addEventListener('keydown', markActive);
  window.addEventListener('click', markActive);
}

function playMotionFromText(text) {
  if (!text) return;
  // 用户自定义触发映射优先（config.motionTriggers）
  const triggers = (config && config.motionTriggers) || [];
  if (triggers.length) {
    for (const t of triggers) {
      const kws = String(t.keywords || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (!kws.length || !t.action) continue;
      if (kws.some(k => text.includes(k))) {
        console.log('[motion] 命中触发词「' + t.keywords + '」→ 动作「' + t.action + '」类型=' + t.type + '（模型类型=' + activeModelType + '，触发配置共' + triggers.length + '条）');
        if (t.type === 'expression') {
          const ok = playExpression(t.action);
          if (ok) { console.log('[motion] 表情播放成功：' + t.action); return; }
          // 模型没有独立表情（如 z23）：表情名转语义动作兜底
          const expToMotion = {
            'F01': '开心', 'F02': '生气', 'F03': '点头', 'F04': '开心',
            'F05': '惊讶', 'F06': '害羞', 'F07': '点头', 'F00': '点头', 'F08': '点头'
          };
          const fallback = expToMotion[String(t.action).toUpperCase()] || t.action;
          if (playMotion(fallback)) { console.log('[motion] 表情兜底动作成功：' + fallback); return; }
        } else {
          const ok = playMotion(t.action);
          console.log('[motion] playMotion(' + t.action + ') 结果=' + ok + '（activeModelType=' + activeModelType + '，vrmAdapter=' + !!vrmAdapter + '）');
          if (ok) return;
        }
      }
    }
  }
  const tags = text.match(/[\[【]([^\]】]{1,6})[\]】]/g) || [];
  for (const tag of tags) {
    let name = tag.replace(/[\[【\]】]/g, '');
    if (playMotion(name)) { console.log('[motion] 标签动作成功：[' + name + ']'); return; }
  }
  // 关键词匹配
  if (/挥手|招手|嗨|哈喽|你好|hello|hi/i.test(text)) playMotion('挥手');
  else if (/摸头|摸摸|摸一摸|摸摸头/i.test(text)) playMotion('触摸');
  else if (/开心|高兴|哈哈|嘿嘿|好耶/i.test(text)) playMotion('开心');
  else if (/点头|嗯嗯|好的|没问题|当然/i.test(text)) playMotion('点头');
  else if (/摇头|不行|不要|拒绝/i.test(text)) playMotion('摇头');
  else if (/惊讶|哇|真的吗|什么/i.test(text)) playMotion('惊讶');
  else if (/害羞|脸红|讨厌|哼/i.test(text)) playMotion('害羞');
  else if (/生气|不理你/i.test(text)) playMotion('生气');
}

/* ================= 聊天 ================= */
async function chat(text) {
  // 用户回话：重置连续开口计数，恢复自主找话题
  onUserReplied();
  addMsg('me', text);
  // 用户输入也能触发模型动作（如“摸摸头”摸头）
  playMotionFromText(text);
  if (chatBusy) { chatQueue.push(text); return; } // 上一条还没回完：排队，避免并发乱序
  chatBusy = true;
  setTyping(true, '正在想…');
  document.body.classList.add('talking');
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: activeSid })
    });
    const data = await r.json();
    setTyping(false);
    if (data.error) { addMsg('her', '（' + data.error + '）'); return; }
    const reply = (data.reply || '…').trim();
    addMsg('her', reply, data.reasoning);
    playMotionFromText(reply);
    say(stripActionTags(reply), 4500);
    if (synthOn) speak(reply);
    // 同步内存历史，避免翻页重复
    allHistory.push({ role: 'user', content: text }, { role: 'assistant', content: reply, reasoning: data.reasoning || undefined });
    historyLoaded = Math.min(allHistory.length, historyLoaded + 2);
  } catch (e) {
    setTyping(false);
    addMsg('her', '（连接不上大脑…请检查 API 配置）');
  } finally {
    document.body.classList.remove('talking');
    chatBusy = false;
    // 处理排队的下一条用户消息
    if (chatQueue.length) { const nxt = chatQueue.shift(); chat(nxt); }
  }
}

function sendChat() {
  const t = chatInput.value.trim();
  if (!t) return;
  chatInput.value = '';
  chat(t);
}

$('chatSend').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
$('chatResetBtn').addEventListener('click', async () => {
  if (!confirm('确定清空当前角色的对话记录？')) return;
  await fetch('/api/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: activeSid }) });
  chatMsgs.innerHTML = '';
  allHistory = [];
  historyLoaded = 0;
});

/* ================= 面板管理 ================= */
const panels = [chatPanel, charPanel, settingsPanel, memPanel];
const panelBtns = [null, null, null, null]; // 底栏按钮已移到 dock.html 浮窗，宠物窗内不再有这些元素

function togglePanel(panel, btn) {
  const idx = panels.indexOf(panel);
  const willShow = !panel.classList.contains('show');
  panels.forEach((p, i) => {
    const show = willShow && i === idx;
    p.classList.toggle('show', show);
    if (panelBtns[i]) panelBtns[i].classList.toggle('active', show);
  });
  document.body.classList.toggle('panel-open', willShow);
  syncCanvasPointer(); // 面板开关立即同步画布交互，避免“关掉面板后拖不动”
  // 面板打开时：临时退出穿透，让鼠标能操作面板（否则面板中间区域鼠标穿透到桌面，关不掉）
  try {
    if (ipcRenderer) {
      if (willShow) {
        console.log('[panel-ipc] open -> set-ignore-mouse(false)');
        ipcRenderer.send('set-ignore-mouse', false);
      } else if (ghostMode) {
        console.log('[panel-ipc] close -> set-ignore-mouse(true) (ghost)');
        ipcRenderer.send('set-ignore-mouse', true);
      }
    } else {
      console.log('[panel-ipc] ipcRenderer 不可用');
    }
  } catch (e) { console.log('[panel-ipc] err', e.message); }
  if (willShow && panel === memPanel) loadMemPanel();
  // 打开设置面板时，用当前已加载模型刷新动作/表情触发列表（避免中途换模型后列表仍是旧的）
  if (willShow && panel === settingsPanel) {
    refreshTriggerModelInfo();
    renderTriggerList(config.motionTriggers || []);
  }
  return willShow;
}

// 保险：面板打开时，点击面板外部区域（窗口空白处）关闭面板并恢复穿透状态
const panelContainer = document.body;
panelContainer.addEventListener('pointerdown', (e) => {
  const anyOpen = panels.some(p => p.classList.contains('show'));
  if (!anyOpen) return;
  const inPanel = !!(e.target && e.target.closest && e.target.closest('.panel'));
  const inDock = !!(e.target && e.target.closest && e.target.closest('#dock'));
  console.log('[panel-close] pointerdown target=', (e.target && e.target.id) || (e.target && e.target.className) || e.target, 'inPanel=', inPanel, 'inDock=', inDock);
  if (inPanel || inDock) return;
  // 点击空白处：关闭所有面板
  panels.forEach((p, i) => { p.classList.remove('show'); if (panelBtns[i]) panelBtns[i].classList.remove('active'); });
  document.body.classList.remove('panel-open');
  syncCanvasPointer(); // 关闭面板立即恢复画布交互（Live2D 可拖动）
  try { if (ghostMode) ipcRenderer.send('set-ignore-mouse', true); } catch (err) {}
});
// 底栏按钮已移至 dock.html，事件在 dock.html 内绑定（发送 open-* IPC）

/* ================= 角色卡 ================= */
async function loadCharacters() {
  try {
    const r = await fetch('/api/characters');
    const j = await r.json();
    characters = j.list || [];
    activeCharName = j.active || '';
    const ac = characters.find(c => c.name === activeCharName);
    if (ac) {
      activeCharLabel = ac.label || ac.name;
      activeCharModel = ac.model || '';
      charTtsSpeaker = ac.tts_speaker || '';
      if (ac.mood) document.body.dataset.mood = ac.mood;
    }
    renderCharList();
    await syncActiveSession();
    return j;
  } catch (e) { return null; }
}

// 从服务器同步当前活跃会话 id（与聊天窗共享同一真相源）
async function syncActiveSession() {
  try {
    const r = await fetch('/api/sessions');
    const j = await r.json();
    activeSid = j.active || null;
  } catch (e) { activeSid = null; }
}

function renderCharList() {
  charList.innerHTML = '';
  characters.forEach(c => {
    const card = document.createElement('div');
    card.className = 'char-card' + (c.name === activeCharName ? ' on' : '');
    const moodClass = c.mood || 'pink';
    card.innerHTML =
      '<div class="cc-info">' +
        '<div class="cc-row">' +
          '<span class="mood-dot ' + moodClass + '"></span>' +
          '<span class="cn">' + (c.label || c.name) + '</span>' +
        '</div>' +
        '<div class="cd">' + (c.desc || '') + '</div>' +
      '</div>' +
      '<div class="cc-actions">' +
        '<button class="cc-act" data-act="edit" title="编辑人设">✎</button>' +
        '<button class="cc-act del" data-act="del" title="删除">✕</button>' +
      '</div>';
    // 点击卡片主体 → 切换角色
    card.querySelector('.cc-info').addEventListener('click', async () => {
      const r = await fetch('/api/characters/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name })
      });
      const j = await r.json();
      if (j.ok) {
        const ch = j.character || {};
        activeCharName = ch.name || c.name;
        activeCharLabel = ch.label || c.label || c.name;
        const newModel = ch.model || c.model || '';
        charTtsSpeaker = ch.tts_speaker || c.tts_speaker || '';
        if (ch.mood || c.mood) document.body.dataset.mood = ch.mood || c.mood;
        renderCharList();
        // 始终重载模型（角色切换后表情/动作可能不同）
        activeCharModel = newModel;
        // 先加载聊天记录，模型后台加载不阻塞UI
        chatMsgs.innerHTML = '';
        historyLoaded = 0;
        await loadChatHistory();
        // 模型异步加载（不 await，避免阻塞聊天窗口）
        if (activeCharModel) loadModel(activeCharModel);
        else loadModel('');
        if (j.character && j.character.first_mes) {
          addMsg('her', j.character.first_mes);
          say(stripActionTags(j.character.first_mes), 4000);
          if (synthOn) speak(j.character.first_mes);
        }
      }
    });
    // 编辑按钮
    card.querySelector('[data-act="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      editCharacter(c.name);
    });
    // 删除按钮
    card.querySelector('[data-act="del"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCharacter(c.name);
    });
    charList.appendChild(card);
  });
}

/* ---- 编辑角色 ---- */
let editingCharName = null;

async function editCharacter(name) {
  try {
    const r = await fetch('/api/characters/detail?name=' + encodeURIComponent(name));
    const c = await r.json();
    if (!c || c.error) { alert('加载失败: ' + (c?.error || '未知错误')); return; }
    editingCharName = name;
    $('cfTitle').textContent = '编辑: ' + (c.label || name);
    $('cfName').value = c.name || '';
    $('cfName').readOnly = true;
    $('cfLabel').value = c.label || '';
    $('cfDesc').value = c.description || '';
    $('cfPersonality').value = c.personality || '';
    $('cfScenario').value = c.scenario || '';
    $('cfFirstMes').value = c.first_mes || '';
    $('cfModel').value = c.model || '';
    $('cfTtsSpeaker').value = c.tts_speaker || '';
    $('cfMemoryInterval').value = c.memory_interval || 20;
    $('cfMood').value = c.mood || 'pink';
    $('cfRules').value = (c.rules || []).join('\n');
    $('charForm').style.display = 'block';
    $('charForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { alert('加载失败: ' + e.message); }
}

/* ---- 删除角色 ---- */
async function deleteCharacter(name) {
  if (!confirm('确定删除角色「' + name + '」？此操作不可撤销。')) return;
  try {
    const r = await fetch('/api/characters?name=' + encodeURIComponent(name), { method: 'DELETE' });
    const j = await r.json();
    if (!j.ok) { alert('删除失败: ' + (j.error || '')); return; }
    if (activeCharName === name) {
      activeCharName = j.active || '';
      const ac = characters.find(c => c.name === activeCharName);
      if (ac) {
        activeCharLabel = ac.label || ac.name;
        activeCharModel = ac.model || '';
        charTtsSpeaker = ac.tts_speaker || '';
        if (ac.mood) document.body.dataset.mood = ac.mood;
        if (activeCharModel) loadModel(activeCharModel);
      }
      chatMsgs.innerHTML = '';
      historyLoaded = 0;
    await loadChatHistory();
    }
    await loadCharacters();
    renderCharList();
    say('已删除 ♪');
  } catch (e) { alert('删除失败: ' + e.message); }
}

// 新建角色表单
$('charAddBtn').addEventListener('click', () => {
  editingCharName = null;
  $('cfTitle').textContent = '新建角色';
  $('cfName').value = '';
  $('cfName').readOnly = false;
  ['cfLabel','cfDesc','cfPersonality','cfScenario','cfFirstMes','cfModel','cfRules']
    .forEach(id => $(id).value = '');
  $('cfTtsSpeaker').value = '';
  $('cfMemoryInterval').value = 20;
  $('cfMood').value = 'pink';
  $('charForm').style.display = 'block';
  $('charForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('cfName').focus();
});
$('cfCancel').addEventListener('click', () => { $('charForm').style.display = 'none'; });
$('cfSave').addEventListener('click', async () => {
  const val = id => $(id).value.trim();
  const name = val('cfName');
  if (!name) { alert('请填写标识 name'); return; }
  const payload = {
    name,
    label: val('cfLabel') || name,
    description: val('cfDesc'),
    personality: val('cfPersonality'),
    scenario: val('cfScenario'),
    first_mes: val('cfFirstMes'),
    model: val('cfModel'),
    tts_speaker: $('cfTtsSpeaker').value,
    memory_interval: parseInt($('cfMemoryInterval').value, 10) || 20,
    mood: val('cfMood'),
    rules: val('cfRules').split(/\n+/).map(s => s.trim()).filter(Boolean),
    active: true
  };
  try {
    const r = await fetch('/api/characters', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok) { alert('保存失败: ' + (j.error || r.status)); return; }
    characters = j.list || [];
    activeCharName = j.active || name;
    const ac = characters.find(c => c.name === activeCharName);
    if (ac) {
      activeCharLabel = ac.label || ac.name;
      activeCharModel = ac.model || '';
      charTtsSpeaker = ac.tts_speaker || '';
      if (ac.mood) document.body.dataset.mood = ac.mood;
    }
    renderCharList();
    $('charForm').style.display = 'none';
    editingCharName = null;
    // 重新加载模型和对话
    if (activeCharModel) await loadModel(activeCharModel);
    chatMsgs.innerHTML = '';
    historyLoaded = 0;
    await loadChatHistory();
    if (payload.first_mes) {
      addMsg('her', payload.first_mes);
      say(stripActionTags(payload.first_mes), 4000);
      if (synthOn) speak(payload.first_mes);
    }
  } catch (e) { alert('保存失败: ' + e.message); }
});

/* ================= 设置 ================= */
async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    config = await r.json();
    // 填充 API 输入框
    $('apiBase').value = config.api?.base || '';
    $('apiKey').value = config.api?.key || '';
    $('apiModel').value = config.api?.model || '';
    // 语音开关
    synthOn = config.tts?.enabled || false;
    $('ttsTog').classList.toggle('on', !!config.tts?.enabled);
    $('sttTog').classList.toggle('on', !!config.stt?.enabled);
    // 自动找话题开关
    autoReplyOn = config.autoReply !== false;
    const arTog = $('autoReplyTog');
    if (arTog) arTog.classList.toggle('on', autoReplyOn);
    // 自动找话题延迟与次数
    autoReplyDelayMs = Math.max(5000, (Number(config.autoReplyDelay) || 40) * 1000);
    autoReplyMaxCount = Math.max(0, Number(config.autoReplyMaxCount) || 0);
    if (autoReplyMaxCount === 0) autoReplyMaxCount = 0; // 0 = 不限制
    // 同步迷你面板滑条
    const arDelayEl2 = $('arDelayRange');
    if (arDelayEl2) {
      const dv = Number(config.autoReplyDelay) || 40;
      arDelayEl2.value = dv;
      const dl = $('arDelayVal');
      if (dl) dl.textContent = dv;
    }
    const arMaxCntEl2 = $('arMaxCountRange');
    if (arMaxCntEl2) {
      const cv = Math.max(0, Number(config.autoReplyMaxCount) || 0);
      arMaxCntEl2.value = cv;
      const cl = $('arMaxCountVal');
      if (cl) cl.textContent = (cv > 0 ? cv : '∞');
    }
    const arCfgBox = $('autoReplyCfg');
    if (arCfgBox) arCfgBox.style.display = autoReplyOn ? '' : 'none';
    // 触摸身体发语音开关
    pokeSpeakOn = config.pokeSpeak !== false;
    const psTog = $('pokeSpeakTog');
    if (psTog) psTog.classList.toggle('on', pokeSpeakOn);
    // 小动作开关（默认开）
    idleAnimEnabled = config.idleAnim !== false;
    // 触摸手势配置（轻触/双击/长按 → 发给模型的词）
    touchCfg = (config.touch && typeof config.touch === 'object') ? config.touch : DEFAULT_TOUCH;
    // 透视透明度
    ghostOpacity = Math.max(10, Math.min(90, Number(config.ghostOpacity) || 40));
    const goRange = $('ghostOpacityRange');
    if (goRange) {
      goRange.value = ghostOpacity;
      const goVal = $('ghostOpacityVal');
      if (goVal) goVal.textContent = ghostOpacity + '%';
    }
    // 全局规则书
    $('globalRulesInput').value = (config.globalRules || []).join('\n');
    // 动作/表情触发配置
    renderTriggerList(config.motionTriggers || []);
    refreshTriggerModelInfo();
    // 恢复上次的缩放比例（重启后人物保持大小）
    if (config.zoomLevel) {
      zoomLevel = Math.max(0.3, Math.min(ZOOM_MAX, Number(config.zoomLevel)));
      const lbl = document.getElementById('zoomLabel');
      if (lbl) lbl.textContent = Math.round(zoomLevel * 100) + '%';
    }
    // 应用缩放：让整个窗口随 zoomLevel 变大/变小（main.js 保持中心、夹屏），
    // 否则启动后窗口仍是基准 520x580、人物偏小且自定义区域坐标对不上
    try { setZoom(zoomLevel); } catch (e) {}
    // 配置（重）载后立即刷新透视透明度，否则改完设置不生效
    applyGhostOpacity();
    return config;
  } catch (e) { return null; }
}

/* ---- 动作/表情触发配置 ---- */
// 获取当前模型全部动作选项（动作组 + 空分组文件名，去重）
function getMotionActionOptions() {
  const set = new Set();
  getMotionGroups().forEach(g => { if (g) set.add(g); });
  getUngroupedMotionNames().forEach(n => set.add(n));
  return [...set];
}

// 采集当前模型全部可用动作/表情（供设置/角色窗口展示）
function collectModelActions() {
  return {
    loaded: !!(live2dModel || activeModelType === 'vrm'),
    groups: getMotionGroups(),
    ungrouped: getUngroupedMotionNames(),
    expressions: getExpressionNames()
  };
}
// 主动推送模型动作/表情列表给设置/角色窗口
function pushModelActions() {
  try { ipcRenderer.send('model-actions', collectModelActions()); } catch (e) {}
}
if (ipcRenderer) ipcRenderer.on('query-model-actions', () => pushModelActions());

// 渲染当前模型可用的动作/表情列表（信息展示）
function refreshTriggerModelInfo() {
  const el = $('triggerModelInfo');
  if (!el) return;
  const d = collectModelActions();
  const lines = [];
  if (!d.loaded) { el.textContent = '（模型未加载，打开面板前先确认模型已加载）'; return; }
  if (d.groups.length) {
    lines.push('动作组: ' + (d.groups.length > 20 ? d.groups.slice(0, 20).join(', ') + ' …' : d.groups.join(', ')));
  }
  if (d.ungrouped.length) {
    lines.push('动作文件: ' + d.ungrouped.join(', '));
  }
  if (d.expressions.length) {
    lines.push('表情: ' + d.expressions.join(', '));
  }
  el.textContent = lines.length ? lines.join('\n') : '（当前模型没有自带动画/表情，可直接在下方填写任意动作名）';
}

// 渲染触发配置行
function renderTriggerList(triggers) {
  const listEl = $('triggerList');
  if (!listEl) return;
  listEl.innerHTML = '';
  (triggers || []).forEach((t, i) => listEl.appendChild(triggerRowEl(t, i)));
}

// 生成一行触发配置（关键词 + 类型 + 动作/表情下拉选择 + 删除）
function triggerRowEl(t, idx) {
  const row = document.createElement('div');
  row.className = 'trigger-row';
  const motionOpts = getMotionActionOptions();
  const expOpts = getExpressionNames();
  row.innerHTML =
    '<input type="text" class="trig-kw" placeholder="关键词，逗号分隔（如 摸摸头,摸头）" />' +
    '<div class="trig-line">' +
      '<select class="trig-type"><option value="motion">动作</option><option value="expression">表情</option></select>' +
      '<select class="trig-action" title="选择当前模型的动作/表情">' +
        (motionOpts.length ? motionOpts.map(o => '<option value="' + o + '">' + o + '</option>').join('') : '<option value="">（模型未加载）</option>') +
      '</select>' +
      '<button class="trig-del" title="删除">✕</button>' +
    '</div>';
  const kw = row.querySelector('.trig-kw');
  const typeSel = row.querySelector('.trig-type');
  const actionSel = row.querySelector('.trig-action');
  kw.value = t.keywords || '';
  typeSel.value = t.type === 'expression' ? 'expression' : 'motion';
  // 类型切换时动作下拉换成对应选项
  const fillActionSel = () => {
    const opts = typeSel.value === 'expression' ? expOpts : motionOpts;
    actionSel.innerHTML = opts.length
      ? opts.map(o => '<option value="' + o + '">' + o + '</option>').join('')
      : '<option value="">（模型未加载）</option>';
    if (t.action) {
      const hit = opts.find(o => String(o).toLowerCase() === String(t.action).toLowerCase());
      if (hit) actionSel.value = hit;
      else {
        // 已保存但不在当前模型选项里（切换模型等）：保留原值作为手动选项
        const opt = document.createElement('option');
        opt.value = t.action; opt.textContent = t.action + '（自定义）';
        actionSel.appendChild(opt); actionSel.value = t.action;
      }
    }
  };
  fillActionSel();
  typeSel.addEventListener('change', () => {
    const prev = t.action;
    t.action = '';
    fillActionSel();
  });
  actionSel.addEventListener('change', () => { t.action = actionSel.value; });
  row.querySelector('.trig-del').addEventListener('click', () => row.remove());
  return row;
}

/* ---- API 预设管理 ---- */
async function loadApiPresets() {
  try {
    const r = await fetch('/api/apis');
    const j = await r.json();
    const sel = $('apiPreset');
    const apis = j.apis || [];
    sel.innerHTML = '<option value="">-- API 预设 --</option>';
    apis.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.name;
      opt.textContent = a.name + ' (' + (a.model || '?') + ')';
      sel.appendChild(opt);
    });
    // 高亮当前激活的
    if (j.active && j.active.base) {
      const match = apis.find(a => a.base === j.active.base);
      if (match) sel.value = match.name;
    }
  } catch (e) {}
}

async function loadModelList() {
  try {
    const r = await fetch('/api/models');
    const j = await r.json();
    const models = j.models || [];
    // 设置面板下拉
    const sel = $('modelSelect');
    sel.innerHTML = '<option value="">-- 选择模型 --</option>';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.path;
      opt.textContent = (m.custom ? '★ ' : '') + m.name;
      sel.appendChild(opt);
    });
    if (activeCharModel) sel.value = activeCharModel;
    // 角色表单下拉
    const cfSel = $('cfModel');
    cfSel.innerHTML = '<option value="">-- 默认模型 --</option>';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.path;
      opt.textContent = (m.custom ? '★ ' : '') + m.name;
      cfSel.appendChild(opt);
    });
  } catch (e) {}
}

// 把当前生效模型路径持久化写回角色卡（先取详情合并再回写，避免清空其它字段）
async function persistCharModel(modelPath) {
  try {
    const r = await fetch('/api/characters/detail?name=' + encodeURIComponent(activeCharName));
    const card = await r.json();
    if (!card || card.error) return;
    card.model = modelPath || '';
    await fetch('/api/characters', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card)
    });
  } catch (e) {}
}

// 设置面板「应用模型」：把选中的模型设为当前宠物模型并重新加载（自动刷新动作/表情列表），并持久化写回角色卡
$('modelApply').addEventListener('click', async () => {
  const p = $('modelSelect').value || '';
  activeCharModel = p;
  try { await loadModel(p); } catch (e) {}
  // 模型加载完成后 loadModel 已刷新过触发列表，这里再保一次（用当前 config）
  refreshTriggerModelInfo();
  renderTriggerList(config.motionTriggers || []);
  await persistCharModel(p);   // 写回角色卡，重启后保持
  say(p ? '模型已切换~' : '已恢复默认模型', 2000);
});

// 自定义模型：添加到列表
$('modelAddCustom').addEventListener('click', async () => {
  const p = ($('customModelPath').value || '').trim();
  if (!p) { say('请先填自定义模型路径', 2000); return; }
  try {
    const r = await fetch('/api/models/custom', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p })
    });
    const j = await r.json();
    if (j.error) { say('添加失败：' + j.error, 2500); return; }
    await loadModelList();
    $('modelSelect').value = p;
    say('已加入模型列表', 1800);
  } catch (e) { say('添加失败', 2000); }
});

// 自定义模型：从列表移除选中的（仅对自定义模型有效）
$('modelDelCustom').addEventListener('click', async () => {
  const p = $('modelSelect').value || '';
  if (!p) { say('请先选择一个模型', 2000); return; }
  try {
    const r = await fetch('/api/models/custom?path=' + encodeURIComponent(p), { method: 'DELETE' });
    const j = await r.json();
    if (j.error) { say('移除失败：' + j.error, 2500); return; }
    await loadModelList();
    say('已从列表移除', 1800);
  } catch (e) { say('移除失败', 2000); }
});

/* ---- 自定义模型添加/删除 ---- */
/* ---- TTS 音色列表 ---- */
async function loadTtsSpeakers() {
  const sel = $('ttsSpeaker');
  sel.innerHTML = '<option value="">-- 加载中… --</option>';
  try {
    const r = await fetch('/api/tts/speakers');
    const j = await r.json();
    const speakers = j.speakers || [];
    if (!speakers.length) {
      sel.innerHTML = '<option value="">-- 无可用音色 --</option>';
      if (j.error) sel.innerHTML += '<option value="" disabled>（' + j.error + '）</option>';
      return;
    }
    sel.innerHTML = '<option value="">-- 选择音色 --</option>';
    const cfSel = $('cfTtsSpeaker');
    cfSel.innerHTML = '<option value="">-- 角色音色（默认全局） --</option>';
    speakers.forEach(s => {
      const val = typeof s === 'string' ? s : (s.voice_id || s.name || s.id || String(s));
      const label = typeof s === 'string' ? s : (s.name || s.voice_id || String(s));
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      sel.appendChild(opt);
      const opt2 = document.createElement('option');
      opt2.value = val;
      opt2.textContent = label;
      cfSel.appendChild(opt2);
    });
    if (j.current) sel.value = j.current;
  } catch (e) {
    sel.innerHTML = '<option value="">-- 加载失败 --</option>';
  }
}

/* ================= 聊天历史（分页：先渲染最近 N 条，往上翻加载更早） ================= */
const HISTORY_PAGE = 50; // 每页条数
let allHistory = [];     // 当前角色完整历史（内存缓存）
let historyLoaded = 0;   // 已渲染条数
let historyRendering = false;

async function loadChatHistory() {
  try {
    const r = await fetch('/api/chat/history?sessionId=' + encodeURIComponent(activeSid || ''));
    const j = await r.json();
    allHistory = j.messages || [];
    historyLoaded = 0;
    renderHistoryPage();
  } catch (e) {}
}

function renderHistoryPage() {
  if (historyRendering) return;
  historyRendering = true;
  const start = Math.max(0, allHistory.length - historyLoaded - HISTORY_PAGE);
  const slice = allHistory.slice(start, allHistory.length - historyLoaded);
  const frag = document.createDocumentFragment();
  slice.forEach((m, i) => {
    frag.appendChild(buildMsgEl(m.role === 'user' ? 'me' : 'her', m.content, start + i, false, m.reasoning));
  });
  const scrollTop = chatMsgs.scrollTop;
  chatMsgs.insertBefore(frag, chatMsgs.firstChild);
  historyLoaded += slice.length;
  if (historyLoaded < allHistory.length && !document.getElementById('historyMore')) {
    const btn = document.createElement('div');
    btn.id = 'historyMore';
    btn.className = 'history-more';
    btn.textContent = '↑ 加载更早的对话';
    btn.addEventListener('click', () => {
      btn.remove();
      renderHistoryPage();
    });
    chatMsgs.insertBefore(btn, chatMsgs.firstChild);
    chatMsgs.scrollTop = scrollTop;
  }
  historyRendering = false;
  if (historyLoaded === allHistory.length) chatMsgs.scrollTop = chatMsgs.scrollHeight;
}

/* ================= TTS ================= */
// 当前角色绑定的音色（切换角色时更新）；为空则回退到设置面板的全局音色
let charTtsSpeaker = '';

function currentSpeaker() {
  return charTtsSpeaker || config?.tts?.speaker || '辰星-正常';
}

async function speak(text) {
  if (ttsBusy) { ttsQueue.push(text); return; } // 上一条还在播：排队，不丢句
  ttsBusy = true;
  suppressSTT = true;
  fetch('/api/stt/stream/reset').catch(() => {});
  const next = () => { if (ttsQueue.length) { const nxt = ttsQueue.shift(); speak(nxt); } };
  try {
    const clean = text.replace(/^[\[【][^\]】]*[\]】]\s*/, '').slice(0, 300);
    // 不添加情绪前缀（如 [轻笑]），否则 bridge 会覆盖用户选择的音色
    // 仅保留问句标记用于语调（[问句] 不触发音色覆盖）
    const tagged = /[？?]$/.test(clean) ? '[问句]' + clean : clean;
    const r = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: tagged, speaker: currentSpeaker() })
    });
    if (!r.ok) { ttsBusy = false; suppressSTT = false; next(); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let finished = false; // 防 onended/onerror/超时 重复释放锁
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallbackTimer);
      URL.revokeObjectURL(url);
      ttsBusy = false; suppressSTT = false;
      next();
    };
    audio.onended = done;
    audio.onerror = done;
    const fallbackTimer = setTimeout(done, 10000);
    await audio.play();
  } catch (e) {
    console.warn('TTS 异常', e);
    ttsBusy = false; suppressSTT = false;
    next();
  }
}

/* ================= STT（FunASR 流式） ================= */
let listening = false;
let mediaStream = null, audioCtx = null, processor = null, sourceNode = null;
let streamBuffer = [], curStreamText = '';

async function sendStreamChunk(pcmF32) {
  if (suppressSTT) return;
  try {
    const r = await fetch('/api/stt/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: new Float32Array(pcmF32).buffer
    });
    const j = await r.json();
    if (j.final && j.text) {
      curStreamText = '';
      const t = j.text.trim();
      if (t) { chatInput.value = ''; chat(t); }
      voiceState.textContent = '💬 ' + t;
    } else if (j.delta) {
      curStreamText += j.delta;
      chatInput.value = curStreamText;
      chatInput.placeholder = '正在聆听…';
    }
  } catch (e) {}
}

function startListening() {
  if (listening) return;
  if (!navigator.mediaDevices?.getUserMedia) { voiceState.textContent = '不支持录音'; return; }
  curStreamText = ''; streamBuffer = []; suppressSTT = false;
  chatInput.value = ''; chatInput.placeholder = '正在聆听…（停顿自动发送）';
  fetch('/api/stt/stream/reset').catch(() => {});
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    mediaStream = stream;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = e => {
      const data = e.inputBuffer.getChannelData(0);
      const ratio = 16000 / audioCtx.sampleRate;
      const outLen = Math.floor(data.length * ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) out[i] = data[Math.min(Math.floor(i / ratio), data.length - 1)];
      if (suppressSTT) return;
      streamBuffer.push(out);
      while (streamBuffer.length) {
        const total = streamBuffer.reduce((s, b) => s + b.length, 0);
        if (total < 9600) break;
        const merged = new Float32Array(total);
        let off = 0;
        for (const bb of streamBuffer) { merged.set(bb, off); off += bb.length; }
        streamBuffer = [];
        const chunk = merged.subarray(0, 9600);
        const rest = merged.subarray(9600);
        if (rest.length) streamBuffer.push(rest);
        sendStreamChunk(chunk);
      }
    };
    sourceNode.connect(processor);
    processor.connect(audioCtx.destination);
    listening = true;
    voiceState.classList.add('on');
    voiceState.textContent = '🎤 聆听中…';
    // 真正开始聆听后再通知 dock 点亮话筒（getUserMedia 是异步的，早发会是 false）
    try { ipcRenderer.send('voice-state', true); } catch (e) {}
  }).catch(() => {
    voiceState.textContent = '麦克风被拒绝';
    setTimeout(() => voiceState.classList.remove('on'), 2000);
    try { ipcRenderer.send('voice-state', false); } catch (e) {}
  });
}

function stopListening() {
  listening = false;
  voiceState.classList.remove('on');
  try {
    if (processor) { processor.disconnect(); processor.onaudioprocess = null; }
    if (sourceNode) sourceNode.disconnect();
    if (audioCtx?.state !== 'closed') audioCtx?.close();
  } catch (e) {}
  processor = null; sourceNode = null; audioCtx = null;
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  voiceState.textContent = '已停止';
  chatInput.placeholder = '说点什么…';
  if (!curStreamText) chatInput.value = '';
  // 通知 dock 关闭话筒指示灯
  try { ipcRenderer.send('voice-state', false); } catch (e) {}
}

// 语音按钮已移至 dock.html 浮窗：由主进程转发 'voice-toggle' 到这里执行
if (ipcRenderer) {
  ipcRenderer.on('voice-toggle', () => {
    if (listening) { stopListening(); }
    else { startListening(); }
    // 状态由 startListening/stopListening 内部负责通过 voice-state 上报，避免异步时序错误
  });
}

/* ================= Canvas 点击穿透 ================= */
// 统一同步画布交互状态：透视模式 / 面板打开 → 鼠标穿透（pointer-events:none）；
// 其余情况画布可交互（可拖动 / 点身体）。
// 之前只有 mousemove 事件里更新 Live2D canvas，面板关闭后不恢复、必须等鼠标移动才
// 恢复 auto，导致“关闭面板后点身体/拖动没反应”。改为所有状态切换点统一调用本函数。
function syncCanvasPointer() {
  const pass = ghostMode || document.body.classList.contains('panel-open');
  if (pixiApp && pixiApp.view) pixiApp.view.style.pointerEvents = pass ? 'none' : 'auto';
  const vrmCanvas = document.getElementById('vrm-canvas');
  if (vrmCanvas) vrmCanvas.style.pointerEvents = pass ? 'none' : 'auto';
}
document.addEventListener('mousemove', syncCanvasPointer);

/* ================= 面板拖拽 & 缩放 ================= */
function initPanelDragResize() {
  panels.forEach(panel => {
    const header = panel.querySelector('.panel-header');
    if (!header) return;

    // 添加缩放手柄
    const resize = document.createElement('div');
    resize.className = 'panel-resize';
    panel.appendChild(resize);

    // --- 拖拽 ---
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nx = e.clientX - offX;
      let ny = e.clientY - offY;
      nx = Math.max(0, Math.min(nx, window.innerWidth - 50));
      ny = Math.max(0, Math.min(ny, window.innerHeight - 50));
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    // --- 缩放 ---
    let resizing = false, sX = 0, sY = 0, sW = 0, sH = 0;
    resize.addEventListener('mousedown', (e) => {
      resizing = true;
      const rect = panel.getBoundingClientRect();
      sX = e.clientX; sY = e.clientY;
      sW = rect.width; sH = rect.height;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      panel.style.width = Math.max(180, sW + e.clientX - sX) + 'px';
      panel.style.maxHeight = Math.max(200, sH + e.clientY - sY) + 'px';
    });
    document.addEventListener('mouseup', () => { resizing = false; });
  });
}

/* ================= 启动 ================= */
async function boot() {
  // 检查库是否加载
  if (typeof PIXI === 'undefined') {
    statusText.textContent = 'PIXI 库未加载，请检查 lib/ 目录';
    return;
  }
  if (!PIXI.live2d) {
    statusText.textContent = 'pixi-live2d-display 未加载';
    return;
  }

  await loadConfig();
  await loadCharacters();
  await loadModelList();
  await loadChatHistory();
  loadApiPresets();
  loadTtsSpeakers();
  initPanelDragResize();

  // 初始化 PIXI
  if (initPixi()) {
    // 初始化拖拽（确保 Live2D 和 VRM 都能拖）
    setupBodyDrag();
    // 加载模型
    await loadModel(activeCharModel || '');
  }

  // 开场白
  const ac = characters.find(c => c.name === activeCharName);
  if (ac && ac.first_mes) {
    setTimeout(() => {
      // 只有历史为空时才显示开场白
      if (chatMsgs.children.length === 0) {
        addMsg('her', ac.first_mes);
        say(stripActionTags(ac.first_mes), 4500);
        if (synthOn) speak(ac.first_mes);
      }
    }, 2000);
  } else if (chatMsgs.children.length === 0) {
    setTimeout(() => {
      const g = '你好呀～我是你的桌面搭子。先去设置里填一下 API 配置，然后就能跟我聊天啦 ♡';
      addMsg('her', g);
      say(g, 5000);
    }, 2000);
  }
  // 启动自主小动作 + 视线跟随 + 自主找话题
  startAutoLife();
}


/* ================= 记忆面板 ================= */
let currentMem = { facts: [], events: [], items: [], prefs: [], summary: '' };

function memRenderList(containerId, arr, key) {
  const el = $(containerId);
  el.innerHTML = '';
  if (!arr.length) { el.innerHTML = '<div class="mem-empty">（空）</div>'; return; }
  arr.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'mem-item';
    const span = document.createElement('span');
    span.textContent = item;
    const del = document.createElement('button');
    del.className = 'mini-btn sm';
    del.textContent = '×';
    del.addEventListener('click', () => {
      currentMem[key].splice(i, 1);
      memRenderList(containerId, currentMem[key], key);
    });
    row.appendChild(span);
    row.appendChild(del);
    el.appendChild(row);
  });
}

async function loadMemPanel() {
  const name = activeCharName || '';
  const r = await fetch('/api/memory?name=' + encodeURIComponent(name) + '&sessionId=' + encodeURIComponent(activeSid || ''));
  if (!r.ok) return;
  const j = await r.json();
  currentMem = { facts: j.facts || [], events: j.events || [], items: j.items || [], prefs: j.prefs || [], summary: j.summary || '' };
  $('memTitle').textContent = '记忆 · ' + (activeCharLabel || name);
  const ac = characters.find(c => c.name === name);
  $('memIntervalInput').value = (ac && ac.memory_interval) || 20;
  memRenderList('memFactsList', currentMem.facts, 'facts');
  memRenderList('memEventsList', currentMem.events, 'events');
  memRenderList('memItemsList', currentMem.items, 'items');
  memRenderList('memPrefsList', currentMem.prefs, 'prefs');
  $('memSummary').value = currentMem.summary;
}

function memAddItem(key) {
  const inputMap = { facts: 'memFactsInput', events: 'memEventsInput', items: 'memItemsInput', prefs: 'memPrefsInput' };
  const listMap = { facts: 'memFactsList', events: 'memEventsList', items: 'memItemsList', prefs: 'memPrefsList' };
  const input = $(inputMap[key]);
  const v = input.value.trim();
  if (!v) return;
  currentMem[key].push(v);
  input.value = '';
  memRenderList(listMap[key], currentMem[key], key);
}

$('memRefresh').addEventListener('click', loadMemPanel);
$('memIntervalSave').addEventListener('click', async () => {
  const iv = parseInt($('memIntervalInput').value, 10);
  if (!iv || iv < 1) { alert('请输入大于 0 的数字'); return; }
  // 先读完整角色卡，合并后提交，避免覆盖其他字段
  const d = await fetch('/api/characters/detail?name=' + encodeURIComponent(activeCharName));
  const detail = await d.json();
  detail.memory_interval = iv;
  const r = await fetch('/api/characters', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(detail)
  });
  const j = await r.json();
  if (j.ok) { say('记忆阈值已设为 ' + iv, 1500); loadCharacters(); }
  else alert('保存失败: ' + (j.error || ''));
});
['facts', 'events', 'items', 'prefs'].forEach(k => {
  $({ facts: 'memFactsInput', events: 'memEventsInput', items: 'memItemsInput', prefs: 'memPrefsInput' }[k])
    .addEventListener('keydown', e => { if (e.key === 'Enter') memAddItem(k); });
});
document.querySelectorAll('#memPanel [data-add]').forEach(btn => {
  btn.addEventListener('click', () => memAddItem(btn.dataset.add));
});
$('memSave').addEventListener('click', async () => {
  currentMem.summary = $('memSummary').value.trim();
  const r = await fetch('/api/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ name: activeCharName, sessionId: activeSid }, currentMem))
  });
  const j = await r.json();
  if (j.ok) { say('记住啦', 1500); loadMemPanel(); }
});
$('memClear').addEventListener('click', async () => {
  if (!confirm('确定清空 ' + (activeCharLabel || activeCharName) + ' 的全部记忆？')) return;
  currentMem = { facts: [], events: [], items: [], prefs: [], summary: '' };
  await fetch('/api/memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ name: activeCharName, sessionId: activeSid }, currentMem))
  });
  loadMemPanel();
});

boot();
})();
