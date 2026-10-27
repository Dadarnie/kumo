import collections
import difflib
import itertools
import queue
import re
import sys
import threading
import time
from pathlib import Path

import keyboard
import numpy as np
import sounddevice as sd

import config
import whisper_gpu

RATE = 16000  # what Whisper expects
_whisper = None
_piper = None
_sapi = None
_wake = None
on_state = lambda state: None  # chat.py --ui replaces this to update the window
on_heard = lambda text, woke: None  # called with every phrase heard in wake mode
on_level = lambda rms: None         # mic loudness, ~10 times a second while the mic is open (window visualizer)
on_speak = lambda envelope, step: None  # loudness of Kumo's speech, one value per `step` seconds


def _rms(a):
    return float(np.sqrt(np.mean(np.square(a, dtype="float64")))) if len(a) else 0.0


def _load_piper(voice_file=None):
    global _piper
    path = Path(__file__).parent / (voice_file or config.PIPER_VOICE)
    if voice_file:  # explicit file (samples): don't touch the cached default
        from piper import PiperVoice
        return PiperVoice.load(str(path))
    if _piper is None and path.exists():
        from piper import PiperVoice
        _piper = PiperVoice.load(str(path))
    return _piper


def _output_device():
    d = config.OUTPUT_DEVICE
    if d is None or isinstance(d, int):
        return d
    for i, dev in enumerate(sd.query_devices()):
        if dev["max_output_channels"] > 0 and d.lower() in dev["name"].lower():
            return i
    print(f"(OUTPUT_DEVICE '{d}' not found, using Windows default)")


# Short words that only Tagalog uses this often; a reply full of them is spoken with the Tagalog voice.
TAGALOG_WORDS = {"ang", "ng", "mga", "sa", "ay", "ko", "mo", "ito", "iyan", "po", "hindi", "oo", "ako", "ikaw", "siya",
                 "kayo", "tayo", "kami", "namin", "natin", "lang", "din", "rin", "nga", "ba", "kasi", "pero", "kung",
                 "para", "wala", "meron", "salamat", "naman", "yung", "iyong", "niya", "nila", "ano", "bakit", "paano",
                 "saan", "kailan", "talaga", "sige", "opo", "ngayon", "mamaya", "bukas", "alas", "magandang", "na"}


def is_tagalog(text):
    words = re.findall(r"[a-zñ']+", text.lower())
    hits = sum(w in TAGALOG_WORDS for w in words)
    return hits >= 1 and (hits >= 2 or len(words) <= 3) and hits / max(1, len(words)) >= 0.2


_mms = None
_mms_lock = threading.Lock()


def _load_mms():
    """Meta's MMS Tagalog voice (transformers VITS). None when unavailable."""
    global _mms
    with _mms_lock:
        if _mms is None and config.TAGALOG_VOICE:
            try:
                from transformers import AutoTokenizer, VitsModel
                _mms = (VitsModel.from_pretrained(config.TAGALOG_VOICE), AutoTokenizer.from_pretrained(config.TAGALOG_VOICE))
            except Exception as e:
                print(f"(Tagalog voice unavailable: {e})")
                _mms = False
        return _mms or None


def _play(audio, rate):
    """Play float32 or int16 audio, stoppable by barge-in, and report its loudness."""
    level = audio / 32768 if audio.dtype == np.int16 else audio
    step = int(rate * 0.05)
    on_speak([_rms(level[i:i + step]) for i in range(0, len(level), step)], 0.05)
    sd.play(audio, rate, device=_output_device())
    end = time.time() + len(audio) / rate + 0.3
    while time.time() < end and sd.get_stream().active:  # like sd.wait(), but stoppable by barge-in
        if interrupted.is_set():
            sd.stop()
            return False
        time.sleep(0.02)
    return True


def _speak_tagalog(text):
    mms = _load_mms()
    if not mms:
        return False
    import torch
    model, tokenizer = mms
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if not sentence.strip() or interrupted.is_set():
            continue
        with torch.no_grad():
            wave = model(**tokenizer(sentence, return_tensors="pt")).waveform[0].numpy().astype("float32")
        if not _play(wave, model.config.sampling_rate):
            break
    return True


def speakable(text):
    """Markdown marks out, words kept: models sometimes add **bold**, `code` or lists despite the prompt."""
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)                    # [label](url) -> label
    text = re.sub(r"```\w*", " ", text).replace("`", "")                     # code fences and ticks
    text = re.sub(r"^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)", "", text, flags=re.M)  # headings, lists, quotes
    text = text.replace("**", "").replace("__", "")
    text = re.sub(r"(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)", "", text)          # *x* / _x_, not file_name
    return re.sub(r"[ \t]+", " ", text).strip()


def speak(text, voice_file=None):
    """Speak with Piper (Tagalog with the MMS voice); fall back to Windows SAPI (pyttsx3)."""
    global _sapi
    text = speakable(text)
    if not text:
        return
    if not voice_file and is_tagalog(text) and _speak_tagalog(text):
        return
    try:
        voice = _load_piper(voice_file)
        if voice:
            from piper.config import SynthesisConfig
            cfg = SynthesisConfig(length_scale=config.VOICE_SPEED, noise_scale=config.VOICE_VARIATION)
            for chunk in voice.synthesize(text, cfg):
                if interrupted.is_set() or not _play(chunk.audio_int16_array, voice.config.sample_rate):
                    return
            return
        print(f"(Piper voice not found at {config.PIPER_VOICE}, using Windows voice)")
    except Exception as e:
        print(f"(Piper failed: {e}; using Windows voice)")
    import pyttsx3
    _sapi = _sapi or pyttsx3.init()
    _sapi.say(text)
    _sapi.runAndWait()


_speech_q = queue.Queue()
interrupted = threading.Event()  # set by barge-in: stop talking now, drop what is queued
_speaking = threading.Event()


def _speech_worker():
    while True:
        text = _speech_q.get()
        try:
            if not interrupted.is_set():
                _speaking.set()
                if config.BARGE_IN and not muted.is_set() and not any(t.name == "barge-in" for t in threading.enumerate()):
                    threading.Thread(target=_barge_in_monitor, name="barge-in", daemon=True).start()
                speak(text)
        finally:
            if _speech_q.unfinished_tasks <= 1:
                _speaking.clear()
            _speech_q.task_done()


def _barge_in_monitor():
    """While Kumo talks: if you talk over it (or press the hotkey), stop speaking.
    The threshold adapts to how loud Kumo's own voice comes back through the mic (speaker echo)."""
    n, loud, echo, t0 = int(RATE * 0.05), 0, [], time.time()
    try:
        with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=n, device=config.INPUT_DEVICE) as s:
            while _speaking.is_set() and not interrupted.is_set() and not muted.is_set():  # muted = mic stays closed
                level = _rms(s.read(n)[0][:, 0])
                if time.time() - t0 < 0.4:  # first 0.4 s: learn the echo level of Kumo's own voice
                    echo.append(level)
                    continue
                limit = max(config.BARGE_IN_RMS, 3 * (max(echo) if echo else 0))
                loud = loud + 1 if level > limit else 0
                if loud >= 4 or (not config.WAKE_WORD_ENABLED and keyboard.is_pressed(config.HOTKEY)):  # 0.2 s of you
                    print("[barge-in: stopped talking]")
                    interrupted.set()
    except Exception as e:  # never let the monitor break speech
        print(f"(barge-in monitor off: {e})")


def speak_async(text):
    """Queue text to be spoken in order by a background thread."""
    if not any(t.name == "speech" for t in threading.enumerate()):
        threading.Thread(target=_speech_worker, name="speech", daemon=True).start()
    _speech_q.put(text)


def wait_speaking():
    _speech_q.join()


def record():
    """Record the mic while the hotkey is held. Returns float32 mono audio at 16 kHz."""
    print(f"[hold '{config.HOTKEY}' and speak]")
    while muted.is_set() or not keyboard.is_pressed(config.HOTKEY):  # wait for the key (or typed text)
        _check_typed()
        time.sleep(0.03)
    chunks = []
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", device=config.INPUT_DEVICE,
                        callback=lambda d, *_: (chunks.append(d.copy()), on_level(_rms(d)))):
        print("[recording...]")
        on_state("listening")
        while keyboard.is_pressed(config.HOTKEY):
            time.sleep(0.02)
    return np.concatenate(chunks)[:, 0] if chunks else np.zeros(0, dtype="float32")


unsure = False  # True when the last transcription had low confidence (see WHISPER_MIN_LOGPROB)
language = "en"  # language of the last transcription


def _hints():
    """Words Whisper should expect: the assistant name, app names and your own extras."""
    return "Words: " + ", ".join([config.ASSISTANT_NAME, *config.APP_WHITELIST, config.WHISPER_HINTS]).strip(", ") + "."


def _cpu_whisper():
    from faster_whisper import WhisperModel
    return WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=config.WHISPER_THREADS)


def _transcribe(audio, lang, force):
    global _whisper
    if _whisper == "gpu":
        try:
            return whisper_gpu.transcribe(audio, lang, _hints())
        except Exception as e:  # driver or server trouble: keep listening on the CPU
            print(f"[voice] Whisper GPU failed ({e}); using the CPU", file=sys.stderr)
            _whisper = _cpu_whisper()
    segments, info = _whisper.transcribe(audio, language=lang, beam_size=config.WHISPER_BEAM,
                                         initial_prompt=_hints(), vad_filter=not force,  # force = warm-up: run the full model
                                         condition_on_previous_text=False)
    return list(segments), info


def transcribe(audio, force=False):
    global _whisper, unsure, language
    unsure = False
    if len(audio) < RATE * 0.3 and not force:  # under 0.3 s: accidental tap
        return ""
    peak = np.abs(audio).max() if len(audio) else 0
    if 0 < peak < 0.5 and not force:  # quiet voice: raise volume (max x8 so noise isn't blown up)
        audio = audio * min(0.7 / peak, 8)
    if _whisper is None:
        _whisper = "gpu" if whisper_gpu.available() else _cpu_whisper()
    # One pass detects the language while transcribing; only an unexpected language costs a second pass.
    lang = "en" if force else config.WHISPER_LANGUAGE
    segments, info = _transcribe(audio, lang, force)
    if lang is None and info.language not in config.WHISPER_LANGUAGES:
        allowed = [(p, code) for code, p in (info.all_language_probs or []) if code in config.WHISPER_LANGUAGES]
        lang = max(allowed)[1] if allowed else config.WHISPER_LANGUAGES[0]
        segments, info = _transcribe(audio, lang, force)
    language = lang or info.language
    segments = [s for s in segments if not (s.no_speech_prob > 0.6 and s.avg_logprob < -0.5)]  # Whisper's silence rule
    if segments and np.mean([s.avg_logprob for s in segments]) < config.WHISPER_MIN_LOGPROB:
        unsure = True
    text = re.sub(r"\s+", " ", "".join(s.text for s in segments)).strip()  # segments carry their own spaces (and may split a word)
    return "" if _is_hallucination(text) else text


# Phrases Whisper invents from noise or silence (learned from YouTube subtitles). Heard alone, they are dropped.
HALLUCINATIONS = {"thanks for watching", "thank you for watching", "thank you", "thanks", "you", "bye", "hmm",
                  "please subscribe", "subscribe", "like and subscribe", "see you next time", "subtitles by the amaraorg community",
                  "mm", "mmm", "mhm", "uh", "um", "uhm", "ah", "oh", "huh", "okay", "ok", "so"}
SOUND_WORDS = re.compile(r"\b(barks?|barking|music|laughs?|laughing|applause|coughs?|coughing|sighs?|silence|"
                         r"noise|static|beeps?|clicks?|knocking|footsteps|rings?|ringing|wind|rain)\b")


def _is_hallucination(text):
    """Filler, made-up subtitle lines, or a sound caption like '(dog barks)' / '[Music]' instead of real words."""
    t = text.strip()
    if re.fullmatch(r"[\(\[\*♪].*[\)\]\*♪]", t):  # caption in brackets, asterisks or music notes
        return True
    words = re.sub(r"[^a-z ]", "", t.lower()).strip()
    first = (words.split() or [""])[0]
    caption = len(words.split()) <= 3 and SOUND_WORDS.search(words) and first not in COMMAND_WORDS
    return words in HALLUCINATIONS or bool(caption)


COMMAND_WORDS = {"play", "pause", "stop", "open", "turn", "next", "skip", "mute", "unmute", "close", "search", "type",
                 "resume", "start", "find", "show", "put", "lower", "raise", "louder", "quieter"}


def wait_for_wake_word(frames=None):
    """Block until the wake word is heard. `frames` (int16 arrays of 1280 samples) is for testing."""
    global _wake
    if _wake is None:
        import openwakeword
        _wake = openwakeword.Model(wakeword_models=[config.WAKE_WORD_MODEL], inference_framework="onnx")
    _wake.reset()

    def heard(frame):
        return max(_wake.predict(frame).values()) >= config.WAKE_THRESHOLD

    if frames is not None:
        return any(heard(f) for f in frames)
    print(f"[say '{config.WAKE_WORD_MODEL.replace('_', ' ')}']")
    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=1280,
                        device=config.INPUT_DEVICE) as stream:
        while True:
            if heard(stream.read(1280)[0][:, 0]):
                return True


def record_until_silence():
    """Record after the wake word; stop after SILENCE_SECONDS of quiet or MAX_RECORD_SECONDS."""
    print("[listening...]")
    on_state("listening")
    block = int(RATE * 0.1)
    chunks, quiet, spoke = [], 0.0, False
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=block,
                        device=config.INPUT_DEVICE) as stream:
        while len(chunks) * 0.1 < config.MAX_RECORD_SECONDS:
            data = stream.read(block)[0][:, 0]
            chunks.append(data)
            if np.sqrt(np.mean(data ** 2)) >= config.SILENCE_RMS:
                spoke, quiet = True, 0.0
            else:
                quiet += 0.1
                if (spoke and quiet >= config.SILENCE_SECONDS) or (not spoke and quiet >= 5):
                    break
    return np.concatenate(chunks)


typed = queue.Queue()      # text typed in Kumo's Chat: handled like speech, no wake phrase needed
muted = threading.Event()  # mic muted (Kumo's mic button or shortcut): nothing is heard or transcribed
on_mute = lambda is_muted: None


class _Typed(Exception):
    """Raised inside the listening loops when typed text arrives, so listen() returns it at once."""
    def __init__(self, text):
        super().__init__(text)
        self.text = text


def _check_typed():
    if not typed.empty():
        raise _Typed(typed.get())


def toggle_mute():
    muted.clear() if muted.is_set() else muted.set()
    print("[mic muted]" if muted.is_set() else "[mic on]")
    on_mute(muted.is_set())


def _mic_blocks():
    """Endless stream of 0.1 s mic blocks (float32 mono 16 kHz). Close it to release the mic.
    While muted it yields silence; typed text interrupts it (raises _Typed)."""
    n = int(RATE * 0.1)
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=n, device=config.INPUT_DEVICE) as s:
        while True:
            _check_typed()
            block = s.read(n)[0][:, 0].copy()
            if muted.is_set():
                block[:] = 0
            on_level(_rms(block))
            yield block


def _utterance(blocks, max_wait=None):
    """One spoken phrase: starts at the first loud block, ends after SILENCE_SECONDS of quiet.
    Returns None if nothing was said within max_wait seconds (or the blocks ran out)."""
    pre, chunks, quiet, waited = collections.deque(maxlen=3), [], 0.0, 0.0  # pre = lead-in so the first syllable isn't cut
    for b in blocks:
        loud = np.sqrt(np.mean(b ** 2)) >= config.SILENCE_RMS
        if not chunks:
            if loud:
                chunks = [*pre, b]
            else:
                pre.append(b)
                waited += 0.1
                if max_wait and waited >= max_wait:
                    return None
            continue
        chunks.append(b)
        quiet = 0.0 if loud else quiet + 0.1
        if quiet >= config.SILENCE_SECONDS or len(chunks) * 0.1 >= config.MAX_RECORD_SECONDS:
            break
    return np.concatenate(chunks) if chunks else None


def match_wake(text):
    """If text starts with the wake name (e.g. 'Hey, Rafael what time is it'), return the command after it
    ('what time is it', or '' if none). Otherwise None. Fuzzy, because Whisper spells names differently."""
    *lead, name = config.WAKE_PHRASE.lower().split()  # e.g. ["hey"], "kumo"
    words = text.split()

    def like(word, target, cutoff):
        word = re.sub(r"\W", "", word.lower())
        return word in config.WAKE_ALIASES or difflib.SequenceMatcher(None, word, target).ratio() >= cutoff

    # Name as the 1st word, or the 2nd after ANY word: Whisper often mishears "hey" as "here", "now", "hay"...
    # A name later in the sentence ("I told Kumo...") is ignored.
    for i, w in enumerate(words[:len(lead) + 1]):
        if like(w, name, 0.75):
            return " ".join(words[i + 1:]).strip(" ,.!?")
    return None


awake_until = 0.0


_remute = False


def listen_now():
    """Kumo's mic button: the next phrase is a request, even when muted or waiting for "hey kumo"."""
    global _remute
    if muted.is_set():
        toggle_mute()
        _remute = True
    stay_awake()
    on_state("listening")


def listen_done():
    """Mic button tapped again, or the request arrived: the mic goes back to how it was."""
    global _remute
    if _remute:
        _remute = False
        toggle_mute()


def stay_awake():
    """Call after a reply: for WAKE_FOLLOWUP_SECONDS the next phrase needs no wake phrase."""
    global awake_until
    awake_until = time.time() + config.WAKE_FOLLOWUP_SECONDS


def listen_for_wake_phrase(blocks=None):
    """Transcribe each utterance; return the command that follows 'hey kumo' (asks for it if not said yet)."""
    own = blocks is None
    blocks = blocks if blocks is not None else _mic_blocks()
    always = config.ALWAYS_LISTEN
    print("[listening: just talk]" if always else f"[say '{config.WAKE_PHRASE}']")
    try:
        global awake_until
        while True:
            remaining = awake_until - time.time()
            awake = always or remaining > 0  # always-listen, or follow-up window: no wake phrase needed
            if awake:
                on_state("listening")
            audio = _utterance(blocks, max_wait=remaining if awake and not always else None)
            if audio is None:
                if awake and not always:  # follow-up window ran out
                    awake_until = 0.0
                    on_state("idle")
                    print(f"[say '{config.WAKE_PHRASE}']")
                    continue
                return None
            if len(audio) < RATE * 0.4:
                continue
            text = transcribe(audio)
            command = match_wake(text)
            if command is None and (awake or time.time() < awake_until) and text:  # the mic button may open it mid-wait
                command = text  # follow-up: the whole phrase is the request
            if text:
                print(f"[heard] {text!r}" + ("" if command is not None else "  (no wake phrase, ignored)"))
                on_heard(text, command is not None)
            if command is None:
                continue
            on_state("listening")
            if command:
                return "" if unsure else command  # unsure: caller says "didn't catch that"
            print("[listening...]")
            audio = _utterance(blocks, max_wait=5)
            return _sure(transcribe(audio)) if audio is not None else ""
    finally:
        if own:
            blocks.close()


def preload():
    """Load every model now so the first real request isn't slow."""
    _load_piper()
    if config.TAGALOG_VOICE:  # in the background: torch takes a while and English never waits for it
        threading.Thread(target=_load_mms, daemon=True, name="mms-load").start()
    transcribe(np.zeros(RATE, dtype="float32") + 0.001 * np.random.randn(RATE).astype("float32"), force=True)
    if config.WAKE_WORD_ENABLED and not config.WAKE_PHRASE:
        wait_for_wake_word(frames=[np.zeros(1280, dtype="int16")])


def _sure(text):
    """Text, or "" if the last transcription was low confidence (voice.unsure stays True)."""
    return "" if unsure else text


def listen():
    """Next request: spoken (per the configured mode) or typed in Kumo's Chat, whichever comes first."""
    global unsure
    try:
        if config.WAKE_WORD_ENABLED:
            if config.WAKE_PHRASE:
                return listen_for_wake_phrase()
            wait_for_wake_word()
            return _sure(transcribe(record_until_silence()))
        return _sure(transcribe(record()))
    except _Typed as t:
        unsure = False
        return t.text
    finally:
        listen_done()


if __name__ == "__main__":
    if "--mic" in sys.argv:  # live test: what level does the mic give, and what does Whisper hear?
        print(f"Mic: {sd.query_devices(config.INPUT_DEVICE if config.INPUT_DEVICE is not None else sd.default.device[0])['name']}")
        print(f"Speech counts as 'loud' above RMS {config.SILENCE_RMS}. Talk now (Ctrl+C to stop).")
        blocks = _mic_blocks()
        peak = 0.0
        try:
            for b in blocks:
                level = float(np.sqrt(np.mean(b ** 2)))
                peak = max(peak * 0.9, level)
                print(f"\r level {level:.4f} {'#' * min(40, int(level * 400)):<40} {'LOUD' if level >= config.SILENCE_RMS else '    '}", end="", flush=True)
                if level >= config.SILENCE_RMS:
                    audio = _utterance(itertools.chain([b], blocks))
                    print(f"\n heard: {transcribe(audio)!r}  (unsure={unsure}, max level {np.abs(audio).max():.2f})")
        except KeyboardInterrupt:
            pass
        sys.exit()
    if "--devices" in sys.argv:
        print(sd.query_devices())
        print("Windows default in/out:", sd.default.device)
        sys.exit()
    if "--samples" in sys.argv:  # play every downloaded voice with the current speed/variation
        for f in sorted(Path(__file__).parent.glob("voices/*.onnx")):
            print("Playing", f.name)
            speak("Answer. The task is complete. Shall I proceed?", f"voices/{f.name}")
        sys.exit()
    # Test 1: speak.  Test 2: hold hotkey and talk, see the text.
    if "--speak" in sys.argv or len(sys.argv) == 1:
        speak(f"Hello, I am {config.ASSISTANT_NAME}. Voice output is working.")
    if "--listen" in sys.argv or len(sys.argv) == 1:
        print("You said:", listen())
