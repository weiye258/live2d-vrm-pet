// ============================================================
// Live2D 桌宠 · Electron 主进程
// 透明背景 + 置顶 + 可拖动 + 可缩放 + 系统托盘
// ============================================================
const { app, BrowserWindow, Menu, Tray, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// 日志写入：超过 200KB 轮转保留最近 3 份（renderer.log / .1 / .2 / .3），避免无限增长
const LOG_FILE = path.join(__dirname, 'renderer.log');
const LOG_MAX = 200 * 1024;
function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size <= LOG_MAX) return;
    fs.rmSync(LOG_FILE + '.3', { force: true });
    if (fs.existsSync(LOG_FILE + '.2')) fs.renameSync(LOG_FILE + '.2', LOG_FILE + '.3');
    if (fs.existsSync(LOG_FILE + '.1')) fs.renameSync(LOG_FILE + '.1', LOG_FILE + '.2');
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch (e) {}
}
function logAppend(tag, msg) {
  try {
    rotateLog();
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
  } catch (e) {}
}

// 端口：优先读取 config.json 的 port，未配置时默认 8740
const PORT = (function () {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    const p = Number(cfg && cfg.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch (e) {}
  return 8740;
})();

// ===== 稳定性加固：IPC 参数安全化 + 未捕获异常兜底 =====
// 某些 webContents.send 的参数在特定运行时可能不可序列化（含函数/DOM/循环引用之类），
// 主进程会抛 "Error processing argument ... conversion failure" 并导致整个桌宠崩溃退出。
// 这里统一兜底：不可序列化参数降级为字符串并记录日志；任何未捕获异常也只记日志、不退出进程。
function isCloneable(a) {
  try {
    if (typeof structuredClone === 'function') { structuredClone(a); return true; }
    JSON.parse(JSON.stringify(a)); return true;
  } catch (e) { return false; }
}
const { WebContents } = require('electron');
if (WebContents && WebContents.prototype && typeof WebContents.prototype.send === 'function') {
  const _origSend = WebContents.prototype.send;
  WebContents.prototype.send = function (channel, ...args) {
    const safe = args.map((a) => {
      if (a === undefined || a === null) return a;
      if (isCloneable(a)) return a;
      logAppend('ipc-warn', `non-serializable send('${channel}') arg type=${typeof a} -> fallback to string`);
      try { return JSON.stringify(a, (k, v) => (typeof v === 'function' ? '[fn]' : v)); } catch (e) { return String(a); }
    });
    try { return _origSend.apply(this, [channel, ...safe]); }
    catch (e) { logAppend('ipc-err', `send('${channel}') threw: ${e && e.message}`); }
  };
}
process.on('uncaughtException', (err) => {
  try { logAppend('uncaught', (err && err.stack) || String(err)); } catch (e) {}
});

// Live2D 库因模型资源缺失而刷屏的报错关键字（资源本就缺失，不影响功能，纯噪音，过滤掉保持日志干净）
const L2D_NOISE = [
  '[SoundManager]', '[MotionManager]',
  'Failed to load motion', 'Failed to play audio',
  '[XHRLoader]', 'Failed to load resource as',
  'flickHead', 'shizuku/sounds', 'models/shizuku'
];

let win = null;
let bubbleWin = null;
let dockWin = null;
let dockCollapsed = false;          // dock 是否收成小圆点
let bubbleHeadRel = { x: 130, y: 70 }; // 头部相对宠物窗左上角的偏移（渲染进程上报）
let tray = null;
let walkOn = false;                 // 自动游走开关（托盘/右键菜单可切换）
let dragWasWalking = false;         // 拖动开始前游走是否开启（松手后据此决定是否恢复）
let walkCtl = { start: () => {}, stop: () => {} }; // 游走控制器（createWindow 内赋值）

// 自动游走开关持久化（config.json 顶层 autoWalk，默认关）
function loadAutoWalk() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return c.autoWalk === true; // 只有明确设为 true 才开
  } catch (e) { return false; }
}
function saveAutoWalk(on) {
  try {
    const fp = path.join(__dirname, 'config.json');
    let c = {};
    try { c = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) {}
    c.autoWalk = !!on;
    fs.writeFileSync(fp, JSON.stringify(c, null, 2));
  } catch (e) {}
}

// ---- server 进程生命周期：主进程拉起并随退出关闭（解决"关不干净/重启不生效"） ----
const net = require('net');
const { spawn } = require('child_process');
let serverProc = null;
function probeServerUp(port, cb) {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.on('connect', () => { s.destroy(); cb(true); });
  s.on('error', () => cb(false));
}
function ensureServer() {
  probeServerUp(PORT, (up) => {
    if (up) return; // start.bat 已启动或旧实例残留：直接复用，不重复拉起
    try {
      serverProc = spawn('node', [path.join(__dirname, 'server.js')], { stdio: 'inherit', windowsHide: true });
      serverProc.on('exit', (code) => { serverProc = null; logAppend('server', 'server.js 退出 code=' + code); });
      serverProc.on('error', (e) => {
        serverProc = null;
        logAppend('server', 'spawn node 失败(' + (e && e.message) + ')，改为进程内加载');
        try { require(path.join(__dirname, 'server.js')); }
        catch (e2) { logAppend('server', '进程内加载失败: ' + (e2 && e2.message)); }
      });
    } catch (e) { logAppend('server', 'spawn 异常: ' + (e && e.message)); }
  });
}

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
let state = { x: null, y: null, width: 520, height: 580, alwaysOnTop: true };

function loadState() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) {}
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {}
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  // 窗口尺寸始终以基准(520x580)为准：缩放产生的大小不持久化，避免越放越大
  state.width = 520;
  state.height = 580;
  if (state.x === null || state.y === null ||
      state.x + state.width > wa.x + wa.width - 8 ||
      state.y + state.height > wa.y + wa.height - 8 ||
      state.x < wa.x || state.y < wa.y) {
    state.x = wa.x + wa.width - state.width - 16;
    state.y = wa.y + wa.height - state.height - 16;
  }

  win = new BrowserWindow({
    x: state.x, y: state.y,
    width: state.width, height: state.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  // ===== 气泡浮层窗口（独立于宠物窗，可浮在窗框外的桌面上） =====
  bubbleWin = new BrowserWindow({
    width: 248, height: 88,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  bubbleWin.setIgnoreMouseEvents(true); // 点击穿透，不挡桌面/宠物
  // 头部相对宠物窗左上角的偏移（由宠物渲染进程上报），用于定位浮层
  function placeBubble() {
    if (!bubbleWin || bubbleWin.isDestroyed() || !win || win.isDestroyed()) return;
    const [wx, wy] = win.getPosition();
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    // 根部 bug：bubbleHeadRel.x/.y 可能为 NaN（模型加载初期 live2dModel.x 未就绪时，
    // 渲染端算出的 headX=NaN 经 bubble-offset 传过来）。NaN 让 setPosition 抛
    // "conversion failure"，导致每次定位/拖拽都报错。这里统一兜底为有限值。
    const hx = Number.isFinite(bubbleHeadRel.x) ? bubbleHeadRel.x : 130;
    const hy = Number.isFinite(bubbleHeadRel.y) ? bubbleHeadRel.y : 70;
    const px = Math.round(wx + hx - 250);
    const py = Math.round(wy + hy - 36);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    try { bubbleWin.setPosition(px, py); } catch (e) {}
  }
  ipcMain.on('bubble-offset', (e, rel) => {
    // 只接受有限数值，避免 NaN 污染 bubbleHeadRel
    if (rel && Number.isFinite(rel.x) && Number.isFinite(rel.y)) bubbleHeadRel = { x: rel.x, y: rel.y };
    placeBubble();
  });
  ipcMain.on('bubble-show', (e, data) => {
    placeBubble();
    if (!bubbleWin.isVisible()) bubbleWin.show();
    bubbleWin.webContents.send('bubble-text', data);
  });
  ipcMain.on('bubble-hide', () => { try { bubbleWin.hide(); } catch (err) {} });
  // 宠物窗口隐藏/最小化时，气泡一并隐藏
  win.on('hide', () => { try { bubbleWin.hide(); } catch (err) {} });
  win.on('minimize', () => { try { bubbleWin.hide(); } catch (err) {} });
  win.on('show', () => { placeBubble(); });

  // ===== 底栏浮窗（独立于宠物窗，跟随人物浮动） =====
  dockWin = new BrowserWindow({
    width: 380, height: 52,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  dockWin.loadFile(path.join(__dirname, 'dock.html'));
  // dock 是独立浮窗：只在启动时贴宠物窗下边定位一次，之后完全由用户拖动，
  // 拖动人物 / 游走 / 缩放都不会再移动它
  function placeDock() {
    if (!dockWin || dockWin.isDestroyed() || !win || win.isDestroyed()) return;
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const dw = dockCollapsed ? 48 : 380;
    const dh = dockCollapsed ? 48 : 52;
    let dx = wx + Math.round((ww - dw) / 2);   // 贴宠物窗下边居中
    let dy = wy + wh + 6;
    // 下方放不下 → 翻到人物上方；上下都放不下再夹回屏幕内兜底
    if (dy + dh > wa.y + wa.height - 8) dy = wy - dh - 6;
    if (dy < wa.y) dy = Math.max(wa.y, Math.min(wy + wh + 6, wa.y + wa.height - dh - 8));
    dx = Math.max(wa.x + 4, Math.min(dx, wa.x + wa.width - dw - 8));
    dockWin.setPosition(dx, dy);
  }
  placeDock();
  broadcastWinState();
  // 拖拽底栏浮窗（透明窗下 -webkit-app-region 不可靠，用 IPC）
  // dock 是独立浮窗：单独拖动它只移动 dock，拖到哪停在哪，不影响人物位置
  let dockDragOff = null;
  ipcMain.on('dock-drag-start', () => {
    if (!dockWin || dockWin.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const [dx, dy] = dockWin.getPosition();
    dockDragOff = { ox: dx - cur.x, oy: dy - cur.y };
  });
  ipcMain.on('dock-drag-move', () => {
    if (!dockDragOff || !dockWin || dockWin.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    dockWin.setPosition(cur.x + dockDragOff.ox, cur.y + dockDragOff.oy);
  });
  ipcMain.on('dock-drag-end', () => { dockDragOff = null; });
  // 收起为小圆点 / 展开为完整工具栏（位置不变，只改尺寸）
  ipcMain.on('dock-collapse', () => {
    dockCollapsed = true;
    if (!dockWin || dockWin.isDestroyed()) return;
    const b = dockWin.getBounds();
    const cw = 48, ch = 48;
    dockWin.setBounds({ x: Math.round(b.x + (b.width - cw) / 2), y: Math.round(b.y + (b.height - ch) / 2), width: cw, height: ch });
  });
  ipcMain.on('dock-expand', () => {
    dockCollapsed = false;
    if (!dockWin || dockWin.isDestroyed()) return;
    const b = dockWin.getBounds();
    const cw = 380, ch = 52;
    dockWin.setBounds({ x: Math.round(b.x + (b.width - cw) / 2), y: Math.round(b.y + (b.height - ch) / 2), width: cw, height: ch });
  });
  // 宠物隐藏/最小化，底栏一并隐藏；显示时只显示 dock，位置保持用户放置的位置
  win.on('hide', () => { try { dockWin.hide(); } catch (e) {} });
  win.on('minimize', () => { try { dockWin.hide(); } catch (e) {} });
  win.on('show', () => { try { dockWin.show(); } catch (e) {} });

  // ===== 自动游走：宠物窗在屏幕上自己移动（边界反弹 + 随机换向） =====
  // 慢速移动（约 48px/s），碰到屏幕工作区边缘反弹，偶尔随机换向，制造自然溜达感
  const WALK_SPEED = 1.6; // px/帧 @ ~30fps
  let walkTimer = null;
  let walkVel = { x: 0, y: 0 };
  let walkRerollAt = 0;
  function walkTick() {
    if (!win || win.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    let nx = wx + walkVel.x;
    let ny = wy + walkVel.y;
    let bounced = false;
    if (nx < wa.x) { nx = wa.x; walkVel.x = Math.abs(walkVel.x); bounced = true; }
    else if (nx + ww > wa.x + wa.width) { nx = wa.x + wa.width - ww; walkVel.x = -Math.abs(walkVel.x); bounced = true; }
    if (ny < wa.y) { ny = wa.y; walkVel.y = Math.abs(walkVel.y); bounced = true; }
    else if (ny + wh > wa.y + wa.height) { ny = wa.y + wa.height - wh; walkVel.y = -Math.abs(walkVel.y); bounced = true; }
    const now = Date.now();
    if (bounced || now >= walkRerollAt) {
      const ang = Math.random() * Math.PI * 2;
      const sp = WALK_SPEED * (0.7 + Math.random() * 0.6);
      walkVel.x = Math.cos(ang) * sp;
      walkVel.y = Math.sin(ang) * sp;
      walkRerollAt = now + 4000 + Math.random() * 5000;
    }
    try { win.setPosition(Math.round(nx), Math.round(ny)); } catch (e) {}
    placeBubble();
  }
  function startWalk() {
    if (walkTimer) return;
    const ang = Math.random() * Math.PI * 2;
    walkVel.x = Math.cos(ang) * WALK_SPEED;
    walkVel.y = Math.sin(ang) * WALK_SPEED;
    walkOn = true;
    walkRerollAt = Date.now() + 4000 + Math.random() * 5000;
    walkTimer = setInterval(walkTick, 33);
    logAppend('walk', 'started');
  }
  function stopWalk() {
    walkOn = false;
    if (walkTimer) { clearInterval(walkTimer); walkTimer = null; }
    logAppend('walk', 'stopped');
  }
  walkCtl.start = startWalk;
  walkCtl.stop = stopWalk;

  // ===== 自定义窗口拖动（透明窗口下 -webkit-app-region 不可靠） =====
  let dragOffset = null;
  ipcMain.on('drag-start', () => {
    dragWasWalking = walkOn;   // 记住拖动前游走是否开着
    stopWalk();                // 用户拖动时暂停自动游走
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    dragOffset = { x: cursor.x - wx, y: cursor.y - wy };
  });
  ipcMain.on('drag-move', () => {
    if (!dragOffset || !win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      const [wx, wy] = win.getPosition();
      const hx = Number.isFinite(bubbleHeadRel.x) ? bubbleHeadRel.x : 130;
      const hy = Number.isFinite(bubbleHeadRel.y) ? bubbleHeadRel.y : 70;
      const px = Math.round(wx + hx - 250);
      const py = Math.round(wy + hy - 36);
      if (Number.isFinite(px) && Number.isFinite(py)) { try { bubbleWin.setPosition(px, py); } catch (e) {} }
    }
  });
  ipcMain.on('drag-end', () => {
    dragOffset = null;
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      Object.assign(state, { x, y, width: w, height: h });
      saveState();
    }
    // 仅当拖动前游走是开启状态才恢复（关着就不自动游走，避免拖动后突然开始溜达）
    if (dragWasWalking) startWalk();
  });

  // ===== 自定义窗口缩放（拖动虚线框边缘/角，保持锚点边固定、夹在屏幕内） =====
  let resizeState = null;
  ipcMain.on('resize-start', (e, anchor) => {
    if (!win || win.isDestroyed()) return;
    resizeState = { rect: win.getBounds(), anchor };
  });
  ipcMain.on('resize-move', (e, dx, dy) => {
    if (!resizeState || !win || win.isDestroyed()) return;
    const r = resizeState.rect, a = resizeState.anchor;
    const wa = screen.getPrimaryDisplay().workArea;
    const minW = 220, minH = 240, maxW = wa.width - 16, maxH = wa.height - 16;
    let w = r.width, h = r.height, x = r.x, y = r.y;
    if (a.indexOf('e') >= 0) w = r.width + dx;
    if (a.indexOf('s') >= 0) h = r.height + dy;
    if (a.indexOf('w') >= 0) { w = r.width - dx; x = r.x + dx; }
    if (a.indexOf('n') >= 0) { h = r.height - dy; y = r.y + dy; }
    w = Math.max(minW, Math.min(w, maxW));
    h = Math.max(minH, Math.min(h, maxH));
    if (a.indexOf('w') >= 0) x = r.x + r.width - w;   // 右边缘不动
    if (a.indexOf('n') >= 0) y = r.y + r.height - h;  // 下边缘不动
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w - 8));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h - 8));
    try { win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }); } catch (err) {}
  });
  ipcMain.on('resize-end', () => {
    if (win && !win.isDestroyed()) {
      const [w, h] = win.getSize();
      Object.assign(state, { width: w, height: h });
      saveState();
    }
    resizeState = null;
  });

  // ===== 透视模式：窗口忽略鼠标事件，鼠标可穿透到桌面 =====
  // 不用 forward（透明窗口上 Windows 不转发事件），改主进程轮询：
  // 鼠标在窗口内非底部区域 → 穿透；移到底部 dock 工具栏 → 恢复接收（能点按钮）
  let ghostPoll = null;
  ipcMain.on('set-ignore-mouse', (e, ignore) => {
    if (!win || win.isDestroyed()) return;
  logAppend('main-ipc', 'set-ignore-mouse(' + ignore + ')');
    if (ghostPoll) { clearInterval(ghostPoll); ghostPoll = null; }
    if (ignore) {
      win.setIgnoreMouseEvents(true);
      ghostPoll = setInterval(() => {
        if (!win || win.isDestroyed()) { clearInterval(ghostPoll); ghostPoll = null; return; }
        const cur = screen.getCursorScreenPoint();
        // getBounds() 返回 {x, y, width, height} 对象，不是数组
        const b = win.getBounds();
        const inX = cur.x >= b.x && cur.x <= b.x + b.width;
        const inY = cur.y >= b.y && cur.y <= b.y + b.height;
        if (!inX || !inY) { win.setIgnoreMouseEvents(true); return; }
        // 底部 60px 条带 = dock 工具栏区域 → 恢复接收
        const onDock = cur.y >= b.y + b.height - 60;
        win.setIgnoreMouseEvents(!onDock);
      }, 100);
    } else {
      win.setIgnoreMouseEvents(false);
    }
  });

  // 渲染进程可开关自动游走（如将来在设置里加开关）
  ipcMain.on('set-walk', (e, on) => {
    if (on) walkCtl.start(); else walkCtl.stop();
    saveAutoWalk(on);
  });
  // 设置界面打开时查询当前游走状态，确保开关显示与实际一致（托盘/右键切过也准）
  ipcMain.on('query-walk', (e) => {
    try { if (e && e.sender) e.sender.send('walk-state', walkOn); } catch (err) {}
  });

  // 麦克风权限
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    cb(['media', 'mediaKeySystem', 'notifications'].includes(perm));
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm) => {
    return ['media', 'mediaKeySystem', 'notifications'].includes(perm);
  });

  // 加载本地页面（带重试）
  const loadPage = (attempt) => {
    win.loadURL('http://127.0.0.1:' + PORT + '/')
      .catch(() => { if (attempt < 5) setTimeout(() => loadPage(attempt + 1), 1500); });
  };
  loadPage(0);

  // 渲染进程 console 转发到主进程日志（调试用）
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    // 屏蔽 Live2D 库因模型缺失音效/动作资源而刷屏的报错（资源本就缺失，不影响功能）
    if (typeof message === 'string' && L2D_NOISE.some(k => message.indexOf(k) >= 0)) return;
    const tag = ['log', 'warning', 'error', 'debug'][level] || 'log';
    logAppend(tag, message);
  });
  // 页面加载失败/JS 错误
  win.webContents.on('render-process-gone', (e, details) => {
  logAppend('crash', JSON.stringify(details));
  });

  // 右键菜单
  win.webContents.on('context-menu', (e, params) => {
    const menu = Menu.buildFromTemplate([
      { label: state.alwaysOnTop !== false ? '取消置顶' : '置顶显示', click: () => {
        const v = !win.isAlwaysOnTop();
        win.setAlwaysOnTop(v, 'screen-saver');
        state.alwaysOnTop = v; saveState();
      }},
      { type: 'separator' },
      { label: '放大模型', click: () => win.webContents.send('zoom', 0.15) },
      { label: '缩小模型', click: () => win.webContents.send('zoom', -0.15) },
      { label: '重置缩放', click: () => win.webContents.send('zoom-reset') },
      { type: 'separator' },
      { label: '显示/隐藏面板', click: () => win.webContents.send('toggle-panel') },
      { type: 'separator' },
      { label: '切换自动游走', click: () => { const next = !walkOn; if (next) walkCtl.start(); else walkCtl.stop(); saveAutoWalk(next); } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]);
    menu.popup();
  });

  // 定期保存窗口位置（只存坐标，不存尺寸；尺寸由缩放动态决定，避免越放越大）
  const saveTimer = setInterval(() => {
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      Object.assign(state, { x, y });
      saveState();
    }
  }, 2000);
  app.on('before-quit', () => clearInterval(saveTimer));

  win.on('closed', () => { win = null; });
  // 启动全屏鼠标跟随轮询（30fps，系统调用开销极小）
  startGazePolling();
  // 启动自动游走：宠物在屏幕上自己溜达（拖动时暂停，松手恢复）。config.autoWalk=false 时不自动启动
  if (loadAutoWalk()) startWalk();
}

// ===== 全屏鼠标跟随：主进程轮询全局光标，换算成窗口内坐标发给渲染进程 =====
let gazePollTimer = null;
function startGazePolling() {
  if (gazePollTimer) return;
  gazePollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const cursor = screen.getCursorScreenPoint();
      const [wx, wy] = win.getPosition();
      // 窗口内坐标（可能为负/超界，渲染端会 clamp）
      win.webContents.send('gaze', { x: cursor.x - wx, y: cursor.y - wy });
    } catch (e) {}
  }, 33);  // ~30fps，开销极小
  // 确认轮询启动（写日志验证）
  logAppend('gaze-poll', 'started');
}

// ===== 独立聊天窗口 =====
let chatWin = null;
function createChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show();
    chatWin.focus();
    return;
  }
  chatWin = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: 300,
    minHeight: 400,
    frame: true,          // 系统窗口框：可拖动、可调长宽
    resizable: true,
    alwaysOnTop: false,   // 聊天窗不需要置顶
    skipTaskbar: false,   // 独立窗口显示在任务栏
    title: '聊天',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });
  chatWin.setMenuBarVisibility(false);
  chatWin.loadURL('http://127.0.0.1:' + PORT + '/chat.html').catch(() => {});
  chatWin.on('closed', () => { chatWin = null; broadcastWinState(); });
  // 聊天窗也转发 console（调试用）
  chatWin.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const tag = ['log', 'warning', 'error', 'debug'][level] || 'log';
    logAppend('chat-' + tag, message);
  });
}

// 主窗口请求打开/关闭独立聊天窗（点 💬 切换：再点一次关闭）
ipcMain.on('open-chat-window', () => {
  if (chatWin && !chatWin.isDestroyed()) {
    // 已打开：关闭
    chatWin.close();
    chatWin = null;
    broadcastWinState();
    return;
  }
  createChatWindow();
  broadcastWinState();
});

// ===== 独立设置窗口 / 独立记忆窗口 / 独立角色窗口（同聊天窗模式，可拖动缩放） =====
let settingsWin = null;
let memWin = null;
let charWin = null;

// 窗口开关状态同步到主窗口渲染进程（dock 按钮高亮）
function broadcastWinState() {
  if (!dockWin || dockWin.isDestroyed()) return;
  dockWin.webContents.send('win-state', {
    chat: !!(chatWin && !chatWin.isDestroyed()),
    settings: !!(settingsWin && !settingsWin.isDestroyed()),
    memory: !!(memWin && !memWin.isDestroyed()),
    characters: !!(charWin && !charWin.isDestroyed())
  });
}

function createPanelWindow(kind) {
  const isSettings = kind === 'settings';
  const isMemory = kind === 'memory';
  const isChars = kind === 'characters';
  let w;
  if (isSettings) w = settingsWin;
  else if (isMemory) w = memWin;
  else w = charWin;
  if (w && !w.isDestroyed()) {
    w.close();
    if (isSettings) settingsWin = null;
    else if (isMemory) memWin = null;
    else charWin = null;
    broadcastWinState();
    return;
  }
  const nw = new BrowserWindow({
    width: isSettings ? 480 : (isMemory ? 420 : 460),
    height: 620,
    minWidth: 360,
    minHeight: 460,
    frame: true,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    title: isSettings ? '设置' : (isMemory ? '记忆' : '角色'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'panel-preload.js')
    }
  });
  nw.setMenuBarVisibility(false);
  const page = isSettings ? 'settings.html' : (isMemory ? 'memory.html' : 'characters.html');
  nw.loadURL('http://127.0.0.1:' + PORT + '/' + page).catch(() => {});
  nw.on('closed', () => {
    if (isSettings) settingsWin = null;
    else if (isMemory) memWin = null;
    else charWin = null;
    broadcastWinState();
  });
  // 转发 console 到 renderer.log（调试用）
  nw.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const tag = ['log', 'warning', 'error', 'debug'][level] || 'log';
  logAppend(isSettings ? 'settings' : (isMemory ? 'mem' : 'chars'), message);
  });
  if (isSettings) settingsWin = nw;
  else if (isMemory) memWin = nw;
  else charWin = nw;
  broadcastWinState();
}
ipcMain.on('open-settings-window', () => createPanelWindow('settings'));
ipcMain.on('open-memory-window', () => createPanelWindow('memory'));
ipcMain.on('open-characters-window', () => createPanelWindow('characters'));
// settings/characters 改模型后通知主窗口重载
ipcMain.on('notify-model-changed', () => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('reload-model');
  }
  // 聊天窗：立即刷新历史，不再等 8s 轮询
  if (chatWin && !chatWin.isDestroyed()) {

    chatWin.webContents.send('character-changed');
  }
  // 设置/角色窗口：角色可能已切换，立即按最新角色刷新配置（不依赖主窗重载模型成功）
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('character-changed');
  if (charWin && !charWin.isDestroyed()) charWin.webContents.send('character-changed');
});

// 聊天窗切换/新建/删除会话后，把新活跃会话 id 广播给宠物主窗
ipcMain.on('session-active', (e, sid) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('session-changed', sid);
  }
});
// 设置窗口改了配置 → 通知宠物窗重新载入 config 实时生效
ipcMain.on('notify-config-changed', () => {
  if (win && !win.isDestroyed()) win.webContents.send('reload-config');
});
// 设置/角色窗口查询当前模型的动作/表情可用列表 → 转发给宠物主窗（模型实例在宠物窗）
ipcMain.on('query-model-actions', () => {
  if (win && !win.isDestroyed()) win.webContents.send('query-model-actions');
});
// 宠物主窗回报模型动作/表情可用列表 → 转发给设置/角色窗口展示
ipcMain.on('model-actions', (e, data) => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('model-actions', data);
  if (charWin && !charWin.isDestroyed()) charWin.webContents.send('model-actions', data);
});
// 小动作开关变更 → 转发给宠物窗
ipcMain.on('idle-anim-changed', (e, on) => {
  if (win && !win.isDestroyed()) win.webContents.send('idle-anim-changed', on);
});

// ===== 底栏浮窗按钮 → 转发给宠物窗执行（语音/透视状态存在宠物窗） =====
ipcMain.on('toggle-ghost', () => { if (win && !win.isDestroyed()) win.webContents.send('ghost-toggle'); });
// 设置窗口拖动透视透明度滑条 → 转发给宠物窗实时预览
ipcMain.on('ghost-opacity-preview', (e, v) => {
  if (win && !win.isDestroyed()) win.webContents.send('ghost-opacity', Number(v));
});
ipcMain.on('toggle-voice', () => { if (win && !win.isDestroyed()) win.webContents.send('voice-toggle'); });
// 底栏浮窗的缩放按钮 → 转发给宠物窗（宠物窗监听 'zoom'）
ipcMain.on('zoom', (e, delta) => { if (win && !win.isDestroyed()) win.webContents.send('zoom', delta); });
// 宠物窗回报状态 → 转发给底栏浮窗高亮
ipcMain.on('ghost-state', (e, v) => { if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('ghost-state', v); });
ipcMain.on('voice-state', (e, v) => { if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('voice-state', v); });
ipcMain.on('zoom-state', (e, pct) => { if (dockWin && !dockWin.isDestroyed()) dockWin.webContents.send('zoom-state', pct); });
// 设置页请求截图当前宠物 → 抓图后回传给设置窗（用于自定义触摸区域的圈选预览）
ipcMain.on('capture-pet', () => {
  if (!win || win.isDestroyed()) return;
  try {
    const p = win.webContents.capturePage();
    Promise.resolve(p).then(img => {
      try {
        const dataUrl = img.toDataURL();
        const sz = img.getSize();
        if (settingsWin && !settingsWin.isDestroyed()) {
          settingsWin.webContents.send('pet-snapshot', { dataUrl, w: sz.width, h: sz.height });
        }
      } catch (e) {}
    }).catch(() => {});
  } catch (err) {}
});

function createTray() {
  // 用一个 1x1 透明 PNG 作为托盘图标（无 ico 文件时的兜底）
  const iconPath = path.join(__dirname, 'icon.png');
  let icon = iconPath;
  if (!fs.existsSync(iconPath)) {
    // 生成一个最小的透明 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(iconPath, png);
    icon = iconPath;
  }
  tray = new Tray(icon);
  tray.setToolTip('Live2D 桌宠');
  tray.on('click', () => {
    if (win) {
      if (win.isVisible()) win.hide();
      else { win.show(); win.focus(); }
    }
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示桌宠', click: () => { if (win) { win.show(); win.focus(); } }},
    { label: '隐藏桌宠', click: () => { if (win) win.hide(); }},
    { type: 'separator' },
    { label: '退出透视模式', click: () => {
        if (win && !win.isDestroyed()) {
          win.setIgnoreMouseEvents(false);
          win.webContents.send('ghost-off');
        }
    }},
    { type: 'separator' },
    { label: '切换自动游走', click: () => { const next = !walkOn; if (next) walkCtl.start(); else walkCtl.stop(); saveAutoWalk(next); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

// 单实例锁：防止重复启动出现"两个小人"（多个宠物窗共享同一配置/端口会互相打架）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑：直接退出，由下面 second-instance 把已有窗口拉到前台
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    ensureServer(); // 未监听到端口则由主进程拉起 server
    loadState();
    createWindow();
    createTray();
  });
  app.on('will-quit', () => {
    if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
  });
}

app.on('window-all-closed', (e) => { e.preventDefault(); });
// 托盘模式下不退出，只有显式 quit 才退出
ipcMain.on('app-quit', () => app.quit());
