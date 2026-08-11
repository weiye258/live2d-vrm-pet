# -*- coding: utf-8 -*-
r"""
Live2D 女友专用 FunASR 实时流式识别服务（独立于酒馆的 8765）

- 端口: 8766（酒馆用 8765，互不干扰）
- 模型: 复用酒馆已缓存的 Paraformer online 流式模型（MODELSCOPE_CACHE 同目录，不重复下载）
- 端点:
  POST /transcribe    整段 wav 识别（前端"录音->停止->识别"用），返回 {"text": "..."}
  POST /stream        流式识别：前端持续 POST 16k 单声道 PCM 块，
                       每块返回该块新识别出的字（边说边出字）
  GET  /health        健康检查
- 用法（/stream 流式）:
  前端先把麦克风 PCM 流切成 600ms 块(9600 采样点)，逐块 POST 上来:
    fetch('/stream', {method:'POST', headers:{'Content-Type':'application/octet-stream'},
                      body: chunkBytes, keepalive:true})
    -> 响应 {"delta": "新识别的字", "final": false}
  停顿约 1.2s 后发送一块静音, 服务端自动断句并返回 {"final": true, "text": "完整句子"}
"""

import os
import sys
import json
import time
import threading
import numpy as np

# 默认模型缓存到脚本同目录的 models_cache（可用环境变量 MODELSCOPE_CACHE 覆盖）
_DEFAULT_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models_cache")
os.environ.setdefault("MODELSCOPE_CACHE", _DEFAULT_CACHE)

PORT = int(os.environ.get("GF_ASR_PORT", "8766"))
MODEL_ID = os.environ.get(
    "GF_ASR_MODEL",
    "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online",
)
MODEL_REVISION = os.environ.get("GF_ASR_MODEL_REVISION", "v2.0.4")

SAMPLE_RATE = 16000
CHUNK_SIZE = [0, 10, 5]          # 600ms/块
CHUNK_STRIDE = CHUNK_SIZE[1] * 960  # 9600 采样点
ENCODER_LOOK_BACK = 4
DECODER_LOOK_BACK = 1

# 静音断句: 连续 N 块低于阈值判定一句结束
SILENCE_CHUNKS = 2
START_THR = 0.004
SILENCE_THR = 0.003

_log_lock = threading.Lock()


def log(msg):
    with _log_lock:
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)


class ASREngine:
    """单例识别引擎（流式模型非线程安全，全局锁串行化）"""

    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def __init__(self):
        import torch
        from funasr import AutoModel

        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        log(f"加载模型 {MODEL_ID} (device={self.device}) ...")
        t0 = time.time()
        self.model = AutoModel(
            model=MODEL_ID,
            model_revision=MODEL_REVISION,
            device=self.device,
            disable_update=True,
            disable_pbar=True,
        )
        log(f"模型就绪，耗时 {time.time()-t0:.1f}s")

    def transcribe(self, pcm_f32):
        """整段识别：返回文本"""
        with self._lock:
            cache = {}
            text_parts = []
            for i in range(0, len(pcm_f32), CHUNK_STRIDE):
                chunk = pcm_f32[i:i + CHUNK_STRIDE]
                if len(chunk) < CHUNK_STRIDE:
                    # 末尾不足一块：补零到整块
                    pad = np.zeros(CHUNK_STRIDE - len(chunk), dtype=np.float32)
                    chunk = np.concatenate([chunk, pad])
                    is_final = True
                else:
                    is_final = (i + CHUNK_STRIDE >= len(pcm_f32))
                res = self.model.generate(
                    input=chunk,
                    cache=cache,
                    is_final=is_final,
                    chunk_size=CHUNK_SIZE,
                    encoder_chunk_look_back=ENCODER_LOOK_BACK,
                    decoder_chunk_look_back=DECODER_LOOK_BACK,
                )
                text = res[0].get("text", "") if res and res[0] else ""
                if text:
                    text_parts.append(text)
            return "".join(text_parts).strip()


# ---------- 流式会话（每个前端连接一个） ----------
class StreamSession:
    def __init__(self, engine):
        self.engine = engine
        self.cache = {}
        self.pending = np.zeros(0, dtype=np.float32)
        self.in_utt = False
        self.silence_count = 0
        self.full_text = ""
        self.lock = threading.Lock()

    def feed(self, pcm_f32):
        """喂一块 PCM，返回 (delta, final, text)"""
        with self.lock:
            self.pending = np.concatenate([self.pending, pcm_f32])
            deltas = []
            final = False
            while len(self.pending) >= CHUNK_STRIDE:
                chunk = self.pending[:CHUNK_STRIDE]
                self.pending = self.pending[CHUNK_STRIDE:]

                rms = float(np.sqrt(np.mean(chunk ** 2)))

                # 说话前静音直接丢
                if not self.in_utt and rms < START_THR:
                    continue

                sil = rms < SILENCE_THR
                if self.in_utt and sil:
                    self.silence_count += 1
                else:
                    self.silence_count = 0

                is_final = bool(self.in_utt and self.silence_count >= SILENCE_CHUNKS)

                res = self.engine.model.generate(
                    input=chunk,
                    cache=self.cache,
                    is_final=is_final,
                    chunk_size=CHUNK_SIZE,
                    encoder_chunk_look_back=ENCODER_LOOK_BACK,
                    decoder_chunk_look_back=DECODER_LOOK_BACK,
                )
                text = res[0].get("text", "") if res and res[0] else ""
                if text:
                    deltas.append(text)
                    self.in_utt = True
                    self.full_text += text

                if is_final:
                    final = True
                    text_all = self.full_text
                    self.cache = {}
                    self.full_text = ""
                    self.in_utt = False
                    self.silence_count = 0
                    return "".join(deltas), True, text_all

            return "".join(deltas), final, self.full_text


# ---------- HTTP 服务 ----------
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    engine = None  # 类级共享

    def log_message(self, fmt, *args):
        pass  # 关掉默认访问日志噪音

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send_json({"ok": True, "port": PORT, "model": MODEL_ID})

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _body_to_pcm_f32(self, body, is_pcm=False):
        """把请求体转成 float32 单声道 16k PCM。
        支持: 裸 PCM16 / WAV 容器 / float32 原始
        """
        data = body
        if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
            # 解析 WAV：找到 fmt 和 data chunk
            off = 12
            fmt = None
            data_start = None
            data_len = 0
            while off + 8 <= len(data):
                cid = data[off:off + 4]
                sz = int.from_bytes(data[off + 4:off + 8], "little")
                if cid == b"fmt ":
                    fmt = data[off + 8:off + 8 + sz]
                elif cid == b"data":
                    data_start = off + 8
                    data_len = sz
                    break
                off += 8 + sz + (sz % 2)
            if data_start is None:
                return None
            pcm = data[data_start:data_start + data_len]
            if fmt is not None and len(fmt) >= 2:
                ftype = int.from_bytes(fmt[0:2], "little")
                if ftype == 3:  # float32
                    return np.frombuffer(pcm, dtype=np.float32).copy()
            return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        # 裸数据：默认 int16 PCM
        if len(data) % 4 == 0:
            # 尝试 float32（如果是 float 流）
            try:
                arr = np.frombuffer(data, dtype=np.float32)
                if np.all(np.abs(arr) <= 1.0) and arr.size > 0:
                    return arr.copy()
            except Exception:
                pass
        return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0

    def do_POST(self):
        try:
            body = self._read_body()
            if self.path.startswith("/transcribe"):
                pcm = self._body_to_pcm_f32(body)
                if pcm is None or len(pcm) == 0:
                    self._send_json({"text": "", "error": "empty"}, 400)
                    return
                log(f"整段识别: {len(pcm)/SAMPLE_RATE:.2f}s")
                text = Handler.engine.transcribe(pcm)
                log(f"识别结果: {text!r}")
                self._send_json({"text": text, "engine": "funasr-live2d"})
            elif self.path.startswith("/stream"):
                pcm = self._body_to_pcm_f32(body)
                if pcm is None or len(pcm) == 0:
                    self._send_json({"delta": "", "final": False})
                    return
                # 每个连接一个会话（按 remote addr 简单区分；实际前端复用一个连接）
                key = self.client_address[0]
                sess = getattr(self.server, "_stream_sess", None)
                if sess is None:
                    sess = StreamSession(Handler.engine)
                    self.server._stream_sess = sess
                delta, final, text_all = sess.feed(pcm)
                if delta:
                    log(f"流式出字: {delta!r}")
                if final:
                    log(f"断句: {text_all!r}")
                self._send_json({"delta": delta, "final": final, "text": text_all})
            elif self.path.startswith("/stream/reset"):
                self.server._stream_sess = None
                self._send_json({"ok": True})
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as e:
            log(f"处理异常: {e}")
            import traceback
            traceback.print_exc()
            self._send_json({"error": str(e)}, 500)


def main():
    log(f"Live2D 女友 FunASR 流式识别服务启动: http://0.0.0.0:{PORT}")
    log(f"模型: {MODEL_ID}")
    Handler.engine = ASREngine.get()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv._stream_sess = None
    log(f"服务就绪: http://0.0.0.0:{PORT}  (Ctrl+C 退出)")
    srv.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[已退出]", flush=True)
    except Exception as e:
        print(f"\n[出错] {e}", flush=True)
        import traceback
        traceback.print_exc()
        input("\n按回车关闭...")
