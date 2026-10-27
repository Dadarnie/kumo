"""Whisper on the GPU: a whisper.cpp server (Vulkan build) that keeps the model loaded.

voice.transcribe() uses it when config.WHISPERCPP_DIR holds the build and the model, and falls
back to faster-whisper on the CPU otherwise. Its answers have the same shape as faster-whisper's
(segments with text/avg_logprob/no_speech_prob, info with language/all_language_probs).

Build (once): see README "Whisper on the GPU".
"""
import atexit
import ctypes
import io
import json
import subprocess
import threading
import time
import urllib.request
import uuid
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np

import config

PORT = 8178
URL = f"http://127.0.0.1:{PORT}"
_lock = threading.Lock()
_server = None
_job = None
# whisper.cpp names languages in full; Kumo speaks in codes.
CODES = {"english": "en", "tagalog": "tl"}


def _paths():
    root = Path(config.WHISPERCPP_DIR) if config.WHISPERCPP_DIR else None
    if not root:
        return None
    exe, model = root / "build" / "bin" / "whisper-server.exe", root / "models" / config.WHISPERCPP_MODEL
    return (exe, model) if exe.is_file() and model.is_file() else None


def available():
    return _paths() is not None


def _up():
    try:
        urllib.request.urlopen(URL + "/", timeout=1)
        return True
    except Exception:
        return False


def _kill_with_us(process):
    """Put the server in a job object that Windows closes when this assistant exits, however it exits."""
    global _job
    k32 = ctypes.windll.kernel32
    _job = k32.CreateJobObjectW(None, None)

    class Limits(ctypes.Structure):  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION, only LimitFlags matters
        _fields_ = [("pad1", ctypes.c_byte * 16), ("LimitFlags", ctypes.c_uint32), ("pad2", ctypes.c_byte * 140)]
    limits = Limits()
    limits.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    k32.SetInformationJobObject(_job, 9, ctypes.byref(limits), ctypes.sizeof(limits))  # 9 = extended limits
    handle = k32.OpenProcess(0x1F0FFF, False, process.pid)
    k32.AssignProcessToJobObject(_job, handle)
    k32.CloseHandle(handle)


def start():
    """Start the server (or reuse one already answering, e.g. left by a crashed run). Blocks until ready."""
    global _server
    with _lock:
        if _up():
            return
        exe, model = _paths()
        _server = subprocess.Popen([str(exe), "-m", str(model), "--host", "127.0.0.1", "--port", str(PORT), "-fa"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
        _kill_with_us(_server)
        atexit.register(_server.terminate)
        deadline = time.time() + 60
        while not _up():
            if _server.poll() is not None or time.time() > deadline:
                raise RuntimeError("the Whisper GPU server did not start")
            time.sleep(0.2)


def _wav(audio):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return out.getvalue()


def transcribe(audio, lang=None, prompt=""):
    """16 kHz float32 audio -> (segments, info), like faster-whisper's WhisperModel.transcribe."""
    start()
    fields = {"language": lang or "auto", "response_format": "verbose_json", "temperature": "0", "prompt": prompt or ""}
    boundary = uuid.uuid4().hex
    body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                    for k, v in fields.items())
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
             f"Content-Type: audio/wav\r\n\r\n").encode() + _wav(audio) + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(URL + "/inference", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    data = json.loads(urllib.request.urlopen(request, timeout=120).read())
    segments = [SimpleNamespace(text=s.get("text", ""), avg_logprob=s.get("avg_logprob", 0.0),
                                no_speech_prob=s.get("no_speech_prob", 0.0)) for s in data.get("segments", [])]
    name = data.get("detected_language") or data.get("language") or ""
    info = SimpleNamespace(language=CODES.get(name, name),
                           all_language_probs=list((data.get("language_probabilities") or {}).items()))
    return segments, info


if __name__ == "__main__":  # self-check: needs the GPU build; prints SKIP without it
    if not available():
        print("whisper_gpu SKIP (no build at WHISPERCPP_DIR)")
    else:
        silence = np.zeros(16000, dtype="float32")
        t = time.time()
        segs, info = transcribe(silence, "en")
        assert isinstance(segs, list) and info.language in ("en", "english", ""), info
        print(f"whisper_gpu OK ({time.time() - t:.1f}s)")
