// ============================================================
// Live2D 桌宠 · 本地服务器
// 页面: http://127.0.0.1:8740
// 大脑: OpenAI 兼容 API（用户自配） · 适配器接口（预留 QClaw）
// 语音: OmniVoice TTS(可选) + FunASR STT(可选)
// ============================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const CHAR_DIR = path.join(ROOT, 'characters');
const MODELS_DIR = path.join(ROOT, 'models');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CHAT_DIR = path.join(ROOT, 'chat-history');      // 旧版每角色一个文件（仅用于启动时迁移）
const CHAT_FILE = path.join(ROOT, 'chat-history.json'); // 旧版单一文件（仅用于启动时迁移）
const SESSION_DIR = path.join(ROOT, 'sessions');       // 会话登记表：sessions/<角色>.json
const CHATS_DIR = path.join(ROOT, 'chats');            // 新：每角色每会话一个文件：chats/<角色>/<会话>.json
const MEM_DIR = path.join(ROOT, 'memories');           // 记忆目录：memories/<角色>_<会话>.json
const LOG_DIR = path.join(ROOT, 'logs');               // 日志目录：logs/model-request.log 等

// ---------------- 配置 ----------------
let config = {
  api: { base: '', key: '', model: '' },
  tts: { enabled: false, base: 'http://127.0.0.1:9881', speaker: '辰星-正常', emotion: '[轻笑]' },
  stt: { enabled: false, funasr: 'http://127.0.0.1:8766' },
  activeCharacter: 'xiaoye',
  maxHistory: 50,
  maxTokens: 800,           // 每次回复的最大 token 数（64~16384）
  inputMaxTokens: 6000,     // 每次发给模型的最大上下文 token 数（含 system 提示词，512~32768）
  motionTriggersByChar: {}, // 按角色保存的动作/表情触发配置（人物个性化）
  autoReply: true,          // 自动找话题开关（用户不互动时角色主动开口）
  autoReplyDelay: 40,       // 自动找话题：用户无互动多少秒后角色主动开口（5~600）
  autoReplyMaxCount: 5,     // 自动找话题：连续主动开口最多几次（0~50，0=不限制）
  ghostOpacity: 40,         // 透视模式下人物透明度（%）10~90
  vrmOffset: { x: 0, y: 0 }, // VRM 模型在画面中的位置偏移（右键拖拽）
  globalRules: [],
  port: 8740,
  models: [],
  apis: []
};

function deepMerge(base, patch) {
  for (const k of Object.keys(patch || {})) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], patch[k]);
    } else { base[k] = patch[k]; }
  }
  return base;
}
function loadConfig() {
  try { deepMerge(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) {}
  if (config.port) PORT_OVERRIDE = config.port;
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
}
let PORT_OVERRIDE = null;
loadConfig();

for (const d of [CHAR_DIR, MODELS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------------- 角色卡管理 ----------------
let characters = {};
function loadCharacters() {
  characters = {};
  for (const f of fs.readdirSync(CHAR_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CHAR_DIR, f), 'utf8'));
      if (c.name) characters[c.name] = { file: f, ...c };
    } catch (e) {}
  }
}
loadCharacters();
// 启动时为当前角色建立默认会话（含旧数据迁移）
try { ensureSessions(config.activeCharacter); } catch (e) {}

function activeCharacter() {
  return characters[config.activeCharacter] || Object.values(characters)[0] || {
    name: '搭子', label: '搭子', description: '', personality: '', scenario: '',
    first_mes: '你好呀', system_prompt: '', model: ''
  };
}

// ---------------- 聊天历史（持久化：每角色 × 每会话一个文件） ----------------
// 内存缓存: chatCache[ '角色::会话' ] = [{role, content}, ...]
let chatCache = {};

function safeFileName(name) {
  return String(name || 'unknown').replace(/[^\w\u4e00-\u9fa5-]/g, '_');
}
function genSid() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
function cacheKey(name, sid) { return name + '::' + sid; }

// ---- 会话登记表: sessions/<角色>.json -> { active, sessions:[{id,name,createdAt}] } ----
function sessionFileOf(name) { return path.join(SESSION_DIR, safeFileName(name) + '.json'); }
function loadSessions(name) {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFileOf(name), 'utf8'));
    if (s && Array.isArray(s.sessions)) return s;
  } catch (e) {}
  return { active: null, sessions: [] };
}
function saveSessions(name, reg) {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(sessionFileOf(name), JSON.stringify(reg, null, 2));
  } catch (e) {}
}
// 旧版单文件（chat-history/<角色>.json 与 memories/<角色>.json）
function legacyChatFileOf(name) { return path.join(CHAT_DIR, safeFileName(name) + '.json'); }
function legacyMemFileOf(name) { return path.join(MEM_DIR, safeFileName(name) + '.json'); }
function loadLegacyChat(name) {
  try { const a = JSON.parse(fs.readFileSync(legacyChatFileOf(name), 'utf8')); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function loadLegacyMemory(name) {
  try { const m = JSON.parse(fs.readFileSync(legacyMemFileOf(name), 'utf8')); return Object.assign(emptyMemory(), m); }
  catch (e) { return emptyMemory(); }
}
// 确保某角色至少有一个会话；首次访问把旧版记录/记忆迁移成“会话 1”
function ensureSessions(name) {
  let reg = loadSessions(name);
  if (reg.sessions.length === 0) {
    const sid = genSid();
    const legacyChat = loadLegacyChat(name);
    const legacyMem = loadLegacyMemory(name);
    reg.sessions.push({ id: sid, name: '会话 1', createdAt: Date.now() });
    reg.active = sid;
    saveSessions(name, reg);
    if (legacyChat.length) {
      const dir = path.join(CHATS_DIR, safeFileName(name));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, safeFileName(sid) + '.json'), JSON.stringify(legacyChat, null, 1));
    }
    if (legacyMem.facts.length || legacyMem.events.length || legacyMem.items.length || legacyMem.prefs.length || legacyMem.summary) {
      fs.writeFileSync(memoryFileOf(name, sid), JSON.stringify(legacyMem, null, 2));
    }
    // 迁移完成后删掉旧版文件，避免新旧结构并存
    try { fs.unlinkSync(legacyChatFileOf(name)); } catch (e) {}
    try { fs.unlinkSync(legacyMemFileOf(name)); } catch (e) {}
  }
  if (!reg.active || !reg.sessions.find(s => s.id === reg.active)) {
    reg.active = reg.sessions[0].id;
    saveSessions(name, reg);
  }
  return reg;
}
// 校验会话 id 属于该角色，失败回退到 active
function resolveSid(name, sid) {
  const reg = ensureSessions(name);
  return (sid && reg.sessions.find(s => s.id === sid)) ? sid : reg.active;
}

// ---- 新聊天文件: chats/<角色>/<会话>.json ----
function sessionChatDir(name) { return path.join(CHATS_DIR, safeFileName(name)); }
function chatFileOf(name, sid) { return path.join(sessionChatDir(name), safeFileName(sid) + '.json'); }
function loadHistory(name, sid) {
  try {
    const arr = JSON.parse(fs.readFileSync(chatFileOf(name, sid), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveHistory(name, sid) {
  try {
    const dir = sessionChatDir(name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(chatFileOf(name, sid), JSON.stringify(chatCache[cacheKey(name, sid)] || [], null, 1));
  } catch (e) {}
}
// 启动迁移：更早期 chat-history.json 单一文件 → 每角色文件（再交给 ensureSessions 切分）
function migrateLegacyHistory() {
  try {
    if (!fs.existsSync(CHAT_FILE)) return;
    const legacy = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')) || {};
    if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR, { recursive: true });
    for (const name of Object.keys(legacy)) {
      if (!Array.isArray(legacy[name]) || !legacy[name].length) continue;
      const fp = legacyChatFileOf(name);
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(legacy[name], null, 1));
    }
    fs.renameSync(CHAT_FILE, CHAT_FILE + '.bak');
  } catch (e) {}
}
migrateLegacyHistory();

function getHistory(name, sid) {
  const k = cacheKey(name, sid);
  if (chatCache[k] === undefined) chatCache[k] = loadHistory(name, sid);
  return chatCache[k];
}
function pushHistory(name, sid, role, content, extra) {
  const h = getHistory(name, sid);
  const msg = { role, content };
  // 附加展示字段（如 reasoning 思考过程），只存盘不回传模型
  if (extra && typeof extra === 'object') Object.assign(msg, extra);
  h.push(msg);
  if (h.length > config.maxHistory * 2) h.splice(0, h.length - config.maxHistory * 2);
  saveHistory(name, sid);
}
function clearHistory(name, sid) {
  chatCache[cacheKey(name, sid)] = [];
  saveHistory(name, sid);
}

// ============================================================
// 记忆模块（Memory Enhancement）
// 存储: memories/<角色名>_<会话id>.json  （按角色×会话隔离）
// 结构: { facts:[], events:[], items:[], prefs:[], summary:'' }
// 沉淀: 角色卡 memory_mode 字段控制
//   auto  = 日常闲聊：每积累 20 条消息(10轮) 沉淀一次
//   story = 剧情演绎：每 6 条消息(3轮) 沉淀一次
//   off   = 关闭记忆
// 注入: 每次对话把记忆作为 system 消息的一部分，按需携带最近 N 条
// ============================================================

function memoryFileOf(name, sid) {
  return path.join(MEM_DIR, safeFileName(name) + '_' + safeFileName(sid) + '.json');
}
function emptyMemory() {
  return { facts: [], events: [], items: [], prefs: [], summary: '' };
}
function loadMemory(name, sid) {
  try {
    const m = JSON.parse(fs.readFileSync(memoryFileOf(name, sid), 'utf8'));
    return Object.assign(emptyMemory(), m);
  } catch (e) { return emptyMemory(); }
}
function saveMemory(name, sid, mem) {
  try {
    if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true });
    fs.writeFileSync(memoryFileOf(name, sid), JSON.stringify(mem, null, 2));
  } catch (e) {}
}
// 删除某角色的全部记忆文件（删除角色时调用）
function deleteMemory(name) {
  try {
    const prefix = safeFileName(name) + '_';
    if (!fs.existsSync(MEM_DIR)) return;
    for (const f of fs.readdirSync(MEM_DIR)) {
      if (f.startsWith(prefix) && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(MEM_DIR, f)); } catch (e) {}
      }
    }
  } catch (e) {}
}
// 将记忆格式化为 system 提示词片段
function buildMemoryPrompt(char, sid) {
  const mem = loadMemory(char.name, sid);
  const out = [];
  if (mem.facts && mem.facts.length) out.push('【已知事实】' + mem.facts.join('；'));
  if (mem.events && mem.events.length) out.push('【关键事件】' + mem.events.join('；'));
  if (mem.items && mem.items.length) out.push('【物品】' + mem.items.join('；'));
  if (mem.prefs && mem.prefs.length) out.push('【喜好】' + mem.prefs.join('；'));
  if (mem.summary) out.push('【过往回忆】' + mem.summary);
  return out.length ? '以下是你的长期记忆，请自然地运用在对话中（不要刻意背诵，只在相关时提及）：\n' + out.join('\n') : '';
}
// 判定是否该沉淀（按角色 memory_interval 阈值）
function shouldConsolidate(charName, sid) {
  const char = characters[charName] || {};
  const interval = char.memory_interval || 20;
  if (interval <= 0) return false;
  const h = getHistory(charName, sid);
  if (h.length < 4) return false;
  // 只在恰好跨过阈值的倍数时触发一次，避免重复沉淀
  return h.length >= interval && (h.length - interval) % interval === 0;
}
// 把历史交给模型做摘要沉淀
async function consolidateMemory(char, sid) {
  const mem = loadMemory(char.name, sid);
  const h = getHistory(char.name, sid);
  // 摘要自上次沉淀以来的全部新增消息（interval 取角色配置 memory_interval，不写死），
  // 这样两轮沉淀之间没有漏摘缝隙；interval 越大单次摘要越长，按需配置
  const interval = (char && char.memory_interval) || 20;
  const recent = h.slice(-interval).map(m => (m.role === 'user' ? '我：' : char.label + '：') + m.content).join('\n');
  const sys = '你是记忆整理器。把下面的对话整理成结构化记忆，只输出 JSON，不要任何解释。\n' +
    '格式：{"facts":["关于对方/自己的客观事实"],"events":["发生过的重要事件"],"items":["提及的物品"],"prefs":["对方的喜好/厌恶"],"summary":"这段对话的概要(40字内)"}\n' +
    '规则：只记录值得长期记住的；日常寒暄不要记；事实要具体(人名/数字/日期)。\n' +
    '已有记忆：' + JSON.stringify(mem);
  try {
    // brainOpenAI 返回 { reply, reasoning }，取 reply 作为记忆 JSON；输出上限加大到 2000，避免推理模型思考过长截断 JSON
    const res = await brainOpenAI(sys, [{ role: 'user', content: recent }], { maxTokens: 2000 });
    const j = JSON.parse((res.reply || '').replace(/```json|```/g, '').trim());
    // 合并（简单去重：按文本）
    for (const k of ['facts', 'events', 'items', 'prefs']) {
      if (Array.isArray(j[k])) {
        const merged = mem[k].concat(j[k]);
        mem[k] = [...new Set(merged)];
      }
    }
    if (j.summary) mem.summary = j.summary;
    saveMemory(char.name, sid, mem);
    console.log('[记忆] 沉淀完成：' + char.name + '（facts=' + mem.facts.length + ' events=' + mem.events.length +
      ' prefs=' + mem.prefs.length + ' summary=' + (mem.summary ? mem.summary.length + '字' : '无') + '）');
    return true;
  } catch (e) {
    console.log('[记忆] 沉淀失败：' + (e && e.message ? e.message : e));
    return false;
  }
}
// ============================================================
// 大脑适配器接口（Brain Adapter Interface）
// ============================================================
// 当前实现: OpenAI 兼容 API
// 未来扩展: 只需新增一个 brainXxx() 函数，在 brainChat 里按 config.brain 路由即可
//
// 接口约定:
//   async function brain(systemPrompt, messages, config) -> string
//   messages: [{role:'user'|'assistant', content:'...'}]
//   返回: 回复文本

// 记录每次发给模型的完整请求（含 system 提示词与全部消息），追加到 logs/model-request.log
function logModelRequest(payload) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const f = path.join(LOG_DIR, 'model-request.log');
    // 单文件超过 2MB 时轮转（保留最近 1 份历史），避免无限增长
    try {
      if (fs.statSync(f).size > 2 * 1024 * 1024) {
        fs.renameSync(f, path.join(LOG_DIR, 'model-request.1.log'));
      }
    } catch (e) {}
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const msgs = payload.messages || [];
    const roles = msgs.reduce((a, m) => { a[m.role] = (a[m.role] || 0) + 1; return a; }, {});
    const head = '\n===== [' + ts + '] model=' + payload.model + ' · 共' + msgs.length + '条 (' +
      Object.entries(roles).map(function (kv) { return kv[0] + '×' + kv[1]; }).join(', ') + ') =====\n';
    fs.appendFileSync(f, head + JSON.stringify(msgs, null, 2) + '\n');
    console.log('[log] 已记录模型请求 -> logs/model-request.log (' + payload.model + ', ' + msgs.length + ' 条消息)');
  } catch (e) { /* 日志失败不影响主流程 */ }
}

// 粗略估算文本 token 数（中英混排近似：中文约 1 token/字，英文约 3.5 字符/token）
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || [];
  return Math.ceil(cjk.length * 0.9 + (s.length - cjk.length) / 3.5);
}

// 按输入 token 上限截取历史消息（保留最近的，超出部分丢弃，system 提示词始终保留）
// 注意：只回传 role/content，思考过程(reasoning)等展示用字段不回传模型，避免浪费上下文
function trimMessagesByTokens(systemPrompt, messages, limit) {
  const recent = messages.slice(-config.maxHistory);
  const kept = [];
  let total = estimateTokens(systemPrompt);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const t = estimateTokens(m.content);
    if (total + t > limit) break;
    kept.unshift({ role: m.role, content: m.content });
    total += t;
  }
  return kept;
}

async function brainOpenAI(systemPrompt, messages, opts) {
  const api = config.api;
  if (!api.base || !api.key || !api.model) {
    throw new Error('API 未配置完整（请在设置中填写 base / key / model）');
  }
  const payload = {
    model: api.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...trimMessagesByTokens(systemPrompt, messages, Number(config.inputMaxTokens) || 6000)
    ],
    // opts.maxTokens 可覆盖（如记忆沉淀需要更长输出）
    max_tokens: (opts && opts.maxTokens) || config.maxTokens || 800,
    temperature: 0.85
  };
  logModelRequest(payload);   // 每次发给模型的完整聊天记录写日志（可在日志 bat 里查看）
  const r = await proxyJson(api.base + '/chat/completions', JSON.stringify(payload), 120000, {
    'Authorization': 'Bearer ' + api.key,
    'Content-Type': 'application/json'
  });
  if (r.status !== 200) throw new Error('API 返回 ' + r.status + ': ' + r.body.toString('utf8').slice(0, 200));
  const j = JSON.parse(r.body.toString('utf8'));
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const reply = String(msg.content || '').trim();
  if (!reply) throw new Error('API 返回空回复');
  // 思考过程：推理模型（DeepSeek R1 / Qwen 等）返回 reasoning_content，部分 OpenAI 兼容层叫 reasoning
  const reasoning = String(msg.reasoning_content || msg.reasoning || '').trim();
  return { reply, reasoning };
}

// 路由入口：根据 config.brain 选择适配器（当前只有 openai，预留 qclaw）
async function brainChat(message, opts) {
  const char = activeCharacter();
  const charName = char.name;
  const reg = ensureSessions(charName);
  const sid = (opts && opts.sessionId && reg.sessions.find(s => s.id === opts.sessionId)) ? opts.sessionId : reg.active;
  const initiative = !!(opts && opts.initiative);
  let messages;
  if (initiative) {
    // 自主找话题：不写历史；临时追加一条引导消息让模型以"回应"的形式主动开口
    messages = getHistory(charName, sid).concat([{
      role: 'user',
      content: '（此刻你没有收到我的话，只是自己想开口了。直接开启一个新话题。）'
    }]);
  } else {
    pushHistory(charName, sid, 'user', message);
    messages = getHistory(charName, sid);
  }
  const system = buildSystemPrompt(char, { initiative, sessionId: sid });
  // === 适配器路由 ===
  // 当前只有 openai；未来加 QClaw 只需:
  //   if (config.brain === 'qclaw') return brainQClaw(system, messages);
  let out;
  try {
    out = await brainOpenAI(system, messages);
  } catch (e) {
    // 模型调用失败：回滚刚写入的 user 消息，避免历史里残留无回复的残条
    if (!initiative) {
      const h = getHistory(charName, sid);
      if (h.length && h[h.length - 1].role === 'user' && h[h.length - 1].content === message) {
        h.pop();
        saveHistory(charName, sid);
      }
    }
    throw e;
  }
  // 自主找话题的回复也写入历史：这样宠物窗聊天框（开启时）和独立聊天窗（从服务器读）都能看到它
  // 注意：initiative 模式下临时追加的那条“（此刻你没有收到我的话…）”引导语只用于传给模型，从未 pushHistory，故不会进聊天记录
  // 思考过程一并存档（若模型返回了），聊天记录里可折叠展示
  pushHistory(charName, sid, 'assistant', out.reply, out.reasoning ? { reasoning: out.reasoning } : undefined);
  // 记忆沉淀：达到阈值时异步执行，不阻塞回复
  if (shouldConsolidate(charName, sid)) {
    consolidateMemory(char, sid).catch(() => {});
  }
  return out;
}

// 构建系统提示词（从角色卡拼装，酒馆风格）
function buildSystemPrompt(char, opts) {
  const initiative = !!(opts && opts.initiative);
  const lines = [];
  // 全局规则书（作用于所有角色）：放在角色提示词之前，确保优先级最高
  const gRules = Array.isArray(config.globalRules) ? config.globalRules : [];
  if (gRules.length) {
    lines.push('【全局规则 · 所有角色必须遵守】');
    gRules.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  if (char.description) lines.push(char.description);
  if (char.personality) lines.push('性格：' + char.personality);
  if (char.scenario) lines.push('场景：' + char.scenario);
  if (char.system_prompt) lines.push(char.system_prompt);
  const memPrompt = buildMemoryPrompt(char, opts && opts.sessionId);
  if (memPrompt) lines.push(memPrompt);
  if (initiative) {
    // 自主找话题模式：不接续最近对话，主动开启新话题；防止把"主动"当成用户消息回应
    lines.push('现在由你主动开启话题，直接以角色的身份说一句自然的口语开场白，开启一个新话题（心情、趣事、或问我一个问题）。');
    lines.push('不要以"（你"开头，不要引用或重复之前的回复，不要说"你说得对"之类回应性的话。就说你现在想说的。');
  }
  // 回复长度由模型自然发挥（不再注入三档指令，配合 maxTokens 控制）
  lines.push('你可以在回复开头或中间使用动作标记让小人做动作：[开心][惊讶][害羞][生气][跳舞][比心]（最多一个）。');
  if (char.rules && char.rules.length) {
    lines.push('铁律：');
    char.rules.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  return lines.join('\n');
}

// ---------------- 通用工具 ----------------
function proxyJson(targetUrl, body, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const transport = u.protocol === 'https:' ? https : http;
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const req = transport.request({
      hostname: u.hostname, port: port, path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, extraHeaders || {}),
      timeout: timeoutMs
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function proxyGet(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const transport = u.protocol === 'https:' ? https : http;
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const req = transport.request({
      hostname: u.hostname, port: port, path: u.pathname + u.search,
      method: 'GET', timeout: timeoutMs || 10000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 触摸动作词表清洗：只保留 9 个已知部位键，值为非空字符串
const TOUCH_KEYS = ['head', 'face', 'body', 'leftHand', 'rightHand', 'leg', 'tail', 'wing', 'other'];
function sanitizeTouchMap(map) {
  const out = {};
  if (map && typeof map === 'object') {
    TOUCH_KEYS.forEach(k => {
      const v = map[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    });
  }
  return out;
}
// 自定义触摸区域清洗：坐标归一化(0..1)，部位名可任意自定义（如“辫子”），词为 3 类手势短语
function sanitizeTouchZones(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const z of arr) {
    if (!z || typeof z !== 'object') continue;
    const x = Number(z.x), y = Number(z.y), r = Number(z.r);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) continue;
    if (r <= 0) continue;
    // 兼容旧版（prompts 为按部位键的 map）：取第一个值作为短语
    const pick = (m) => {
      if (m && typeof m === 'object') { for (const k of TOUCH_KEYS) if (typeof m[k] === 'string' && m[k].trim()) return m[k].trim(); }
      return '';
    };
    const zone = {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      r: Math.min(1, r),
      name: (typeof z.name === 'string' && z.name.trim()) ? z.name.trim()
          : (typeof z.part === 'string' && z.part.trim() ? z.part.trim() : '未命名部位'),
      tap: (typeof z.tap === 'string' && z.tap.trim()) ? z.tap.trim() : pick(z.prompts),
      double: (typeof z.double === 'string' && z.double.trim()) ? z.double.trim() : pick(z.doublePrompts),
      hold: (typeof z.hold === 'string' && z.hold.trim()) ? z.hold.trim() : pick(z.holdPrompts)
    };
    out.push(zone);
  }
  return out;
}

const MAX_BODY = 5 * 1024 * 1024; // 请求体上限 5MB
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > MAX_BODY) {
        req.destroy();
        reject(new Error('body-too-large'));
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// ---------------- 静态文件 MIME ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.moc': 'application/octet-stream', '.mtn': 'application/octet-stream',
  '.moc3': 'application/octet-stream', '.model3.json': 'application/json; charset=utf-8',
  '.vrm': 'model/gltf-binary',
  '.obj': 'text/plain',
  '.mtl': 'text/plain',
  '.physics3.json': 'application/json; charset=utf-8', '.pose3.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

// ---------------- HTTP 服务 ----------------
const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('Bad Request'); return; }

  /* ---- POST /api/chat ---- */
  if (urlPath === '/api/chat' && req.method === 'POST') {
    let raw;
    try { raw = await readBody(req); }
    catch (e) { return sendJson(res, 400, { error: '请求体过大或读取失败' }); }
    try {
      const { message, sessionId } = JSON.parse(raw || '{}');
      if (!message) return sendJson(res, 400, { error: 'empty' });
      const out = await brainChat(message, { sessionId });
      sendJson(res, 200, { reply: out.reply, reasoning: out.reasoning || '' });
    } catch (e) { sendJson(res, 502, { error: e.message }); }
    return;
  }

  /* ---- POST /api/chat/initiative（自主找话题：角色主动开口） ---- */
  if (urlPath === '/api/chat/initiative' && req.method === 'POST') {
    let raw;
    try { raw = await readBody(req); }
    catch (e) { return sendJson(res, 400, { error: '请求体过大或读取失败' }); }
    try {
      const { sessionId } = JSON.parse(raw || '{}');
      const out = await brainChat('', { initiative: true, sessionId });
      sendJson(res, 200, { reply: out.reply, reasoning: out.reasoning || '' });
    } catch (e) { sendJson(res, 502, { error: e.message }); }
    return;
  }

  /* ---- POST /api/chat/reset ---- */
  if (urlPath === '/api/chat/reset' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { character, sessionId } = JSON.parse(raw || '{}');
      const name = character || activeCharacter().name;
      const sid = resolveSid(name, sessionId);
      clearHistory(name, sid);
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- GET /api/chat/history ---- */
  if (urlPath === '/api/chat/history' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const name = activeCharacter().name;
    const sid = resolveSid(name, u.searchParams.get('sessionId'));
    sendJson(res, 200, { messages: getHistory(name, sid), sessionId: sid });
    return;
  }

  /* ---- POST /api/chat/message/delete（删除某条聊天记录） ---- */
  if (urlPath === '/api/chat/message/delete' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const body = JSON.parse(raw || '{}');
      const name = body.character || activeCharacter().name;
      const sid = resolveSid(name, body.sessionId);
      const idx = Number(body.index);
      const h = getHistory(name, sid);
      if (!Number.isInteger(idx) || idx < 0 || idx >= h.length) {
        return sendJson(res, 400, { error: 'index 越界' });
      }
      h.splice(idx, 1);
      saveHistory(name, sid);
      sendJson(res, 200, { ok: true, messages: h });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- GET /api/characters（列表 + active + 当前 TTS 音色） ---- */
  if (urlPath === '/api/characters' && req.method === 'GET') {
    const list = Object.values(characters).map(c => ({
      name: c.name, label: c.label || c.name, desc: c.description || '',
      mood: c.mood || '', model: c.model || '', avatar: c.avatar || '',
      tts_speaker: c.tts_speaker || '', memory_interval: c.memory_interval || 20
    }));
    sendJson(res, 200, { list, active: config.activeCharacter, tts_speaker: (characters[config.activeCharacter] || {}).tts_speaker || '' });
    return;
  }

  /* ---- GET /api/characters/detail?name=xxx ---- */
  if (urlPath.startsWith('/api/characters/detail') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const name = u.searchParams.get('name');
    const c = characters[name];
    if (!c) return sendJson(res, 404, { error: '角色不存在' });
    sendJson(res, 200, c);
    return;
  }

  /* ---- POST /api/characters（新建/更新角色卡） ---- */
  if (urlPath === '/api/characters' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const body = JSON.parse(raw || '{}');
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: '角色 name 不能为空' });
      if (!/^[\w\u4e00-\u9fa5-]{1,32}$/.test(name)) {
        return sendJson(res, 400, { error: 'name 仅支持中文/字母/数字/下划线/中划线' });
      }
      const c = {
        name,
        label: body.label || name,
        description: body.description || '',
        personality: body.personality || '',
        scenario: body.scenario || '',
        first_mes: body.first_mes || '',
        system_prompt: body.system_prompt || '',
        mes_example: body.mes_example || '',
        mood: body.mood || 'pink',
        model: body.model || '',
        avatar: body.avatar || '',
        tts_speaker: body.tts_speaker || '',
        memory_interval: Number.isFinite(Number(body.memory_interval)) && Number(body.memory_interval) > 0 ? Math.floor(Number(body.memory_interval)) : 20,
        rules: Array.isArray(body.rules) ? body.rules : String(body.rules || '').split(/\n+/).map(s => s.trim()).filter(Boolean),
        alternate_greetings: body.alternate_greetings || []
      };
      fs.writeFileSync(path.join(CHAR_DIR, name + '.json'), JSON.stringify(c, null, 2));
      loadCharacters();
      if (body.active) { config.activeCharacter = name; saveConfig(); }
      sendJson(res, 200, {
        ok: true, active: config.activeCharacter,
        list: Object.values(characters).map(x => ({
          name: x.name, label: x.label || x.name, desc: x.description || '',
          mood: x.mood || '', model: x.model || '',
          memory_interval: x.memory_interval || 20
        }))
      });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- POST /api/characters/active（激活角色 + 返回其 TTS 音色） ---- */
  if (urlPath === '/api/characters/active' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { name } = JSON.parse(raw || '{}');
      if (!characters[name]) return sendJson(res, 404, { error: '角色不存在' });
      config.activeCharacter = name;
      saveConfig();
      const c = characters[name];
      sendJson(res, 200, { ok: true, character: {
        name: c.name, label: c.label || c.name, first_mes: c.first_mes || '',
        mood: c.mood || '', model: c.model || '',
        tts_speaker: c.tts_speaker || ''
      }});
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- DELETE /api/characters?name=xxx ---- */
  if (urlPath === '/api/characters' && req.method === 'DELETE') {
    const u = new URL(req.url, 'http://localhost');
    const name = u.searchParams.get('name');
    if (!characters[name]) return sendJson(res, 404, { error: '角色不存在' });
    try { fs.unlinkSync(path.join(CHAR_DIR, characters[name].file)); } catch (e) {}
    // 删除该角色的所有会话聊天目录
    try { fs.rmSync(sessionChatDir(name), { recursive: true, force: true }); } catch (e) {}
    // 删除该角色旧版聊天文件（若有）
    try { fs.unlinkSync(legacyChatFileOf(name)); } catch (e) {}
    // 删除该角色的全部记忆文件 + 会话登记表
    deleteMemory(name);
    try { fs.unlinkSync(sessionFileOf(name)); } catch (e) {}
    // 清理内存缓存
    for (const k of Object.keys(chatCache)) {
      if (k.startsWith(name + '::')) delete chatCache[k];
    }
    loadCharacters();
    if (config.activeCharacter === name) {
      config.activeCharacter = Object.keys(characters)[0] || '';
      saveConfig();
    }
    sendJson(res, 200, { ok: true, active: config.activeCharacter });
    return;
  }

  /* ---- GET /api/memory?name=xxx（读取角色记忆） ---- */
  if (urlPath === '/api/memory' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const name = u.searchParams.get('name') || config.activeCharacter;
    if (!characters[name]) return sendJson(res, 404, { error: '角色不存在' });
    const sid = resolveSid(name, u.searchParams.get('sessionId'));
    sendJson(res, 200, Object.assign({ name, sessionId: sid }, loadMemory(name, sid)));
    return;
  }

  /* ---- POST /api/memory（编辑保存角色记忆） ---- */
  if (urlPath === '/api/memory' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const body = JSON.parse(raw || '{}');
      const name = String(body.name || '').trim();
      if (!characters[name]) return sendJson(res, 404, { error: '角色不存在' });
      const sid = resolveSid(name, body.sessionId);
      const cur = loadMemory(name, sid);
      for (const k of ['facts', 'events', 'items', 'prefs']) {
        if (Array.isArray(body[k])) cur[k] = body[k].map(s => String(s).trim()).filter(Boolean);
      }
      if (typeof body.summary === 'string') cur.summary = body.summary.trim();
      saveMemory(name, sid, cur);
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- 会话管理（角色 × 会话） ---- */
  // GET /api/sessions?name=xxx -> { active, sessions:[{id,name,createdAt}] }
  if (urlPath === '/api/sessions' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const name = u.searchParams.get('name') || config.activeCharacter;
    const reg = ensureSessions(name);
    sendJson(res, 200, { active: reg.active, sessions: reg.sessions });
    return;
  }
  // POST /api/sessions -> 新建会话并置为 active
  if (urlPath === '/api/sessions' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const body = JSON.parse(raw || '{}');
      const name = config.activeCharacter;
      const reg = ensureSessions(name);
      const sid = genSid();
      const n = reg.sessions.length + 1;
      const sname = String(body.name || '').trim() || ('会话 ' + n);
      reg.sessions.push({ id: sid, name: sname, createdAt: Date.now() });
      reg.active = sid;
      saveSessions(name, reg);
      sendJson(res, 200, { ok: true, active: reg.active, sessions: reg.sessions });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  // POST /api/sessions/active -> 切换 active 会话
  if (urlPath === '/api/sessions/active' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { id } = JSON.parse(raw || '{}');
      const name = config.activeCharacter;
      const reg = ensureSessions(name);
      if (reg.sessions.find(s => s.id === id)) { reg.active = id; saveSessions(name, reg); }
      sendJson(res, 200, { ok: true, active: reg.active, sessions: reg.sessions });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  // POST /api/sessions/rename -> 重命名会话
  if (urlPath === '/api/sessions/rename' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { id, name: sname } = JSON.parse(raw || '{}');
      const name = config.activeCharacter;
      const reg = ensureSessions(name);
      const s = reg.sessions.find(x => x.id === id);
      if (s) { s.name = String(sname || '').trim() || s.name; saveSessions(name, reg); }
      sendJson(res, 200, { ok: true, active: reg.active, sessions: reg.sessions });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  // POST /api/sessions/delete -> 删除会话（聊天+记忆一并删），至少保留 1 个
  if (urlPath === '/api/sessions/delete' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { id } = JSON.parse(raw || '{}');
      const name = config.activeCharacter;
      const reg = ensureSessions(name);
      if (reg.sessions.length <= 1) return sendJson(res, 400, { error: '至少保留一个会话' });
      reg.sessions = reg.sessions.filter(s => s.id !== id);
      if (reg.active === id) reg.active = reg.sessions[0].id;
      saveSessions(name, reg);
      try { fs.unlinkSync(chatFileOf(name, id)); } catch (e) {}
      try { fs.unlinkSync(memoryFileOf(name, id)); } catch (e) {}
      delete chatCache[cacheKey(name, id)];
      sendJson(res, 200, { ok: true, active: reg.active, sessions: reg.sessions });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }
  // POST /api/sessions/clear -> 清空某会话的聊天记录 + 记忆（保留会话本身）
  if (urlPath === '/api/sessions/clear' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { id } = JSON.parse(raw || '{}');
      const name = config.activeCharacter;
      const reg = ensureSessions(name);
      const sid = (reg.sessions.find(s => s.id === id) ? id : reg.active);
      clearHistory(name, sid);
      saveMemory(name, sid, emptyMemory());
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- GET /api/models（列出可用模型） ---- */
  if (urlPath === '/api/models' && req.method === 'GET') {
    const models = [];
    function scan(dir, prefix) {
      try {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (f.isDirectory()) scan(path.join(dir, f.name), prefix + f.name + '/');
          else if (f.name.endsWith('.model.json') || f.name.endsWith('.model3.json') || f.name.endsWith('.vrm') || f.name.endsWith('.obj')) {
            const isVRM = f.name.endsWith('.vrm');
            const isOBJ = f.name.endsWith('.obj');
            models.push({ path: 'models/' + prefix + f.name, name: f.name.replace(/\.model3?\.json$|\.vrm$|\.obj$/, ''), custom: false, type: isVRM ? 'vrm' : isOBJ ? 'vrm' : 'live2d' });
          }
        }
      } catch (e) {}
    }
    scan(MODELS_DIR, '');
    if (Array.isArray(config.models)) {
      config.models.forEach(m => {
        if (!models.find(x => x.path === m.path)) {
          models.push({ path: m.path, name: m.name || m.path, custom: true });
        }
      });
    }
    sendJson(res, 200, { models });
    return;
  }

  /* ---- POST /api/models/custom ---- */
  if (urlPath === '/api/models/custom' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { path: modelPath, name } = JSON.parse(raw || '{}');
      if (!modelPath) return sendJson(res, 400, { error: 'path 不能为空' });
      if (!Array.isArray(config.models)) config.models = [];
      if (!config.models.find(m => m.path === modelPath)) {
        config.models.push({ path: modelPath, name: name || modelPath.replace(/\.model3?\.json$/, '').split('/').pop() });
        saveConfig();
      }
      sendJson(res, 200, { ok: true, models: config.models });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- DELETE /api/models/custom ---- */
  if (urlPath === '/api/models/custom' && req.method === 'DELETE') {
    const u = new URL(req.url, 'http://localhost');
    const modelPath = u.searchParams.get('path');
    if (!Array.isArray(config.models)) config.models = [];
    config.models = config.models.filter(m => m.path !== modelPath);
    saveConfig();
    sendJson(res, 200, { ok: true, models: config.models });
    return;
  }

  /* ---- GET /api/tts/speakers ---- */
  if (urlPath === '/api/tts/speakers' && req.method === 'GET') {
    if (!config.tts.base) return sendJson(res, 200, { speakers: [] });
    try {
      const r = await proxyGet(config.tts.base + '/speakers', 5000);
      if (r.status !== 200) return sendJson(res, 200, { speakers: [] });
      const body = r.body.toString('utf8');
      let speakers = [];
      try {
        const j = JSON.parse(body);
        if (Array.isArray(j)) speakers = j;
        else if (j.speakers) speakers = j.speakers;
        else if (j.data) speakers = j.data;
        else if (typeof j === 'object') speakers = Object.keys(j);
      } catch (e) {
        speakers = body.split(/\n+/).map(s => s.trim()).filter(Boolean);
      }
      sendJson(res, 200, { speakers, current: config.tts.speaker || '' });
    } catch (e) {
      sendJson(res, 200, { speakers: [], current: config.tts.speaker || '', error: e.message });
    }
    return;
  }

  /* ---- GET /api/apis（列出 API 预设） ---- */
  if (urlPath === '/api/apis' && req.method === 'GET') {
    const apis = Array.isArray(config.apis) ? config.apis : [];
    // key 打码后返回，避免明文泄漏
    const masked = apis.map(a => Object.assign({}, a, { key: a.key ? a.key.slice(0, 8) + '••••' : '' }));
    sendJson(res, 200, {
      apis: masked,
      active: { base: config.api.base, model: config.api.model, key: config.api.key ? config.api.key.slice(0, 8) + '••••' : '' }
    });
    return;
  }

  /* ---- POST /api/apis（保存/更新 API 预设） ---- */
  if (urlPath === '/api/apis' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { name, base, key, model } = JSON.parse(raw || '{}');
      if (!name) return sendJson(res, 400, { error: '预设名称不能为空' });
      if (!Array.isArray(config.apis)) config.apis = [];
      // key 被遮蔽时用当前配置的真实 key
      let actualKey = key || '';
      if (actualKey.includes('••••')) actualKey = config.api.key || '';
      // 若是覆盖已有预设，且没传新 key，保留旧 key
      const existing = config.apis.find(a => a.name === name);
      if (!actualKey && existing) actualKey = existing.key || '';
      const preset = { name, base: base || '', key: actualKey, model: model || '' };
      if (existing) Object.assign(existing, preset);
      else config.apis.push(preset);
      saveConfig();
      // 返回时也打码
      const masked = config.apis.map(a => Object.assign({}, a, { key: a.key ? a.key.slice(0, 8) + '••••' : '' }));
      sendJson(res, 200, { ok: true, apis: masked });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- DELETE /api/apis?name=xxx ---- */
  if (urlPath === '/api/apis' && req.method === 'DELETE') {
    const u = new URL(req.url, 'http://localhost');
    const name = u.searchParams.get('name');
    if (!Array.isArray(config.apis)) config.apis = [];
    config.apis = config.apis.filter(a => a.name !== name);
    saveConfig();
    sendJson(res, 200, { ok: true, apis: config.apis });
    return;
  }

  /* ---- POST /api/apis/activate（激活预设 → 写入当前 API） ---- */
  if (urlPath === '/api/apis/activate' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const { name } = JSON.parse(raw || '{}');
      if (!Array.isArray(config.apis)) config.apis = [];
      const preset = config.apis.find(a => a.name === name);
      if (!preset) return sendJson(res, 404, { error: '预设不存在' });
      config.api.base = preset.base || '';
      config.api.key = preset.key || '';
      config.api.model = preset.model || '';
      saveConfig();
      sendJson(res, 200, { ok: true, api: { base: config.api.base, model: config.api.model } });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- GET/POST /api/config ---- */
  if (urlPath === '/api/config' && req.method === 'GET') {
    // 返回配置时隐藏 key 尾部
    const safe = JSON.parse(JSON.stringify(config));
    if (safe.api && safe.api.key) safe.api.key = safe.api.key.slice(0, 8) + '••••';
    // 触发配置按当前角色返回（人物个性化），无则回退全局配置
    delete safe.motionTriggersByChar;
    if (config.motionTriggersByChar && config.motionTriggersByChar[config.activeCharacter]) {
      safe.motionTriggers = config.motionTriggersByChar[config.activeCharacter];
    }
    sendJson(res, 200, safe);
    return;
  }
  if (urlPath === '/api/config' && req.method === 'POST') {
    const raw = await readBody(req).catch(() => '');
    try {
      const patch = JSON.parse(raw || '{}');
      if (patch.api) {
        // key 为 •••• 时不覆盖
        if (patch.api.key && patch.api.key.includes('••••')) delete patch.api.key;
        Object.assign(config.api, patch.api);
      }
      if (patch.tts) Object.assign(config.tts, patch.tts);
      if (patch.stt) Object.assign(config.stt, patch.stt);
      if (patch.activeCharacter) config.activeCharacter = patch.activeCharacter;
      if (patch.maxHistory) config.maxHistory = patch.maxHistory;
      // 每次回复的最大 token 数（64~16384）
      if (patch.maxTokens !== undefined) {
        const t = Number(patch.maxTokens);
        if (!isNaN(t)) config.maxTokens = Math.max(64, Math.min(16384, Math.round(t)));
      }
      // 每次发给模型的最大上下文 token 数（512~32768）
      if (patch.inputMaxTokens !== undefined) {
        const t = Number(patch.inputMaxTokens);
        if (!isNaN(t)) config.inputMaxTokens = Math.max(512, Math.min(32768, Math.round(t)));
      }
      // 自动找话题开关
      if (patch.autoReply !== undefined) config.autoReply = !!patch.autoReply;
      // 自动找话题：延迟秒数与连续次数
      if (patch.autoReplyDelay !== undefined) {
        const d = Number(patch.autoReplyDelay);
        if (!isNaN(d)) config.autoReplyDelay = Math.max(5, Math.min(600, d));
      }
      if (patch.autoReplyMaxCount !== undefined) {
        const c = Number(patch.autoReplyMaxCount);
        if (!isNaN(c)) config.autoReplyMaxCount = Math.max(0, Math.min(50, c));
      }
      // 透视透明度（10~90）
      if (patch.ghostOpacity !== undefined) {
        const g = Number(patch.ghostOpacity);
        if (!isNaN(g)) config.ghostOpacity = Math.max(10, Math.min(90, g));
      }
      // 全局规则书：数组或换行文本
      if (patch.globalRules !== undefined) {
        config.globalRules = Array.isArray(patch.globalRules)
          ? patch.globalRules.map(s => String(s).trim()).filter(Boolean)
          : String(patch.globalRules).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      // 动作/表情触发映射：[{ keywords: '摸头,摸摸', action: 'touch_head', type: 'motion' }]
      // 带 character 时按角色个性化保存（每个角色/人物一套配置），否则存为全局默认
      if (patch.motionTriggers !== undefined) {
        const sanitized = Array.isArray(patch.motionTriggers)
          ? patch.motionTriggers.map(t => ({
              keywords: String(t.keywords || '').trim(),
              action: String(t.action || '').trim(),
              type: t.type === 'expression' ? 'expression' : 'motion'
            })).filter(t => t.keywords && t.action)
          : [];
        const c = String(patch.character || '').trim();
        if (c) {
          if (!config.motionTriggersByChar) config.motionTriggersByChar = {};
          config.motionTriggersByChar[c] = sanitized;
          // 保存的正是当前角色时同步全局，保证运行时立即生效
          if (c === config.activeCharacter) config.motionTriggers = sanitized;
        } else {
          config.motionTriggers = sanitized;
        }
      }
      // 缩放比例持久化（重启后保持人物大小）
      if (patch.zoomLevel !== undefined) {
        const z = Number(patch.zoomLevel);
        if (!isNaN(z)) config.zoomLevel = Math.round(Math.max(0.3, Math.min(3.0, z)) * 100) / 100;
      }
      // VRM 模型在画面中的位置偏移（右键拖拽调整）
      if (patch.vrmOffset !== undefined && patch.vrmOffset && typeof patch.vrmOffset === 'object') {
        config.vrmOffset = {
          x: Math.round((Number(patch.vrmOffset.x) || 0) * 1000) / 1000,
          y: Math.round((Number(patch.vrmOffset.y) || 0) * 1000) / 1000
        };
      }
      // 触摸身体发语音开关
      if (patch.pokeSpeak !== undefined) config.pokeSpeak = !!patch.pokeSpeak;
      // 触摸手势配置：阈值 + 用户自定义区域（9 部位默认词已移除，全部由自定义区域决定）
      if (patch.touch !== undefined && patch.touch && typeof patch.touch === 'object') {
        const t = patch.touch;
        // 按模型保存触摸区域：保留已有 zonesByModel，仅更新本次携带的键
        const oldByModel = (config.touch && config.touch.zonesByModel && typeof config.touch.zonesByModel === 'object')
          ? config.touch.zonesByModel : {};
        const newByModelRaw = (t.zonesByModel && typeof t.zonesByModel === 'object') ? t.zonesByModel : {};
        const newByModel = {};
        for (const k of Object.keys(newByModelRaw)) newByModel[k] = sanitizeTouchZones(newByModelRaw[k]);
        config.touch = {
          holdMs: Math.max(200, Math.min(3000, Number(t.holdMs) || 500)),
          doubleMs: Math.max(100, Math.min(1000, Number(t.doubleMs) || 300)),
          zonesByModel: Object.assign({}, oldByModel, newByModel),
          zones: sanitizeTouchZones(t.zones)
        };
      }
      saveConfig();
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- POST /api/tts ---- */
  if (urlPath === '/api/tts' && req.method === 'POST') {
    if (!config.tts.enabled) return sendJson(res, 503, { error: 'tts-disabled' });
    const raw = await readBody(req).catch(() => '');
    try {
      const { text, speaker } = JSON.parse(raw || '{}');
      if (!text) return sendJson(res, 400, { error: 'empty' });
      const sp = speaker || config.tts.speaker;
      // 同时发送 speaker 和 voice_id，兼容不同 TTS 服务器
      const r = await proxyJson(config.tts.base, JSON.stringify({ text, speaker: sp, voice_id: sp }), 120000);
      if (r.status !== 200) return sendJson(res, 502, { error: 'tts-failed' });
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': r.body.length });
      res.end(r.body);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
    return;
  }

  /* ---- POST /api/stt/stream ---- */
  if (urlPath === '/api/stt/stream' && req.method === 'POST') {
    if (!config.stt.enabled || !config.stt.funasr) return sendJson(res, 503, { error: 'stt-disabled' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const audio = Buffer.concat(chunks);
        const u = new URL(config.stt.funasr + '/stream');
        const req2 = http.request({
          hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': audio.length }, timeout: 10000
        }, r2 => {
          const rc = [];
          r2.on('data', c => rc.push(c));
          r2.on('end', () => {
            res.writeHead(r2.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(Buffer.concat(rc));
          });
        });
        req2.on('timeout', () => req2.destroy(new Error('timeout')));
        req2.on('error', () => sendJson(res, 502, { delta: '', final: false, error: 'stream-down' }));
        req2.write(audio);
        req2.end();
      } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    return;
  }

  /* ---- POST /api/stt/stream/reset ---- */
  if (urlPath === '/api/stt/stream/reset' && req.method === 'POST') {
    if (!config.stt.enabled || !config.stt.funasr) return sendJson(res, 503, { error: 'stt-disabled' });
    try {
      const u = new URL(config.stt.funasr + '/stream/reset');
      const req2 = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Length': 0 } }, r2 => {
        const rc = []; r2.on('data', c => rc.push(c));
        r2.on('end', () => { res.writeHead(r2.statusCode || 200, { 'Content-Type': 'application/json' }); res.end(Buffer.concat(rc)); });
      });
      req2.on('error', () => sendJson(res, 502, { ok: false }));
      req2.end();
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  /* ---- 敏感路径禁止作为静态文件下载 ---- */
  if (/^\/(sessions|chats|memories|chat-history)(\/|$)/.test(urlPath) || urlPath === '/config.json') {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  /* ---- 静态文件 ---- */
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404: ' + urlPath); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

const actualPort = PORT_OVERRIDE || 8740;
const srv = server.listen(actualPort, '127.0.0.1', () => {
  const c = activeCharacter();
  console.log('══════════════════════════════════');
  console.log('  Live2D 桌宠已启动');
  console.log('  页面: http://127.0.0.1:' + actualPort + '/');
  console.log('  当前角色: ' + (c.label || c.name));
  console.log('  API: ' + (config.api.base ? '已配置' : '未配置（请在设置中填写）'));
  console.log('  TTS: ' + (config.tts.enabled ? '开' : '关'));
  console.log('  STT: ' + (config.stt.enabled ? '开' : '关'));
  console.log('══════════════════════════════════');
});
srv.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + actualPort + ' 已被占用。可能是桌宠已在运行，或其它程序占用了该端口。');
    console.error('如需更换端口，请修改 config.json 中的 port 字段后重试。');
  } else {
    console.error('服务器启动失败:', err.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });

// 兜底：异步/未捕获异常不再让服务进程静默退出，记录后继续运行
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
