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

RATE = 16000  # what Whisper expects
_whisper = None
_piper = None
_sapi = None
_wake = None
on_state = lambda state: None  # chat.py --ui replaces this to update the window
on_heard = lambda text, woke: None  # called with every phrase heard in wake mode
on_level = lambda rms: None         # mic loudness, ~10 times a second while the mic is open (window visualizer)
on_speak = lambda envelope, step: None  # loudness of Raphael's speech, one value per `step` seconds


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


def speak(text, voice_file=None):
    """Speak with Piper; fall back to Windows SAPI (pyttsx3)."""
    global _sapi
    try:
        voice = _load_piper(voice_file)
        if voice:
            from piper.config import SynthesisConfig
            cfg = SynthesisConfig(length_scale=config.VOICE_SPEED, noise_scale=config.VOICE_VARIATION)
            for chunk in voice.synthesize(text, cfg):
                audio, rate = chunk.audio_int16_array, voice.config.sample_rate
                step = int(rate * 0.05)
                on_speak([_rms(audio[i:i + step] / 32768) for i in range(0, len(audio), step)], 0.05)
                sd.play(audio, rate, device=_output_device())
                sd.wait()
            return
        print(f"(Piper voice not found at {config.PIPER_VOICE}, using Windows voice)")
    except Exception as e:
        print(f"(Piper failed: {e}; using Windows voice)")
    import pyttsx3
    _sapi = _sapi or pyttsx3.init()
    _sapi.say(text)
    _sapi.runAndWait()


_speech_q = queue.Queue()


def _speech_worker():
    while True:
        text = _speech_q.get()
        try:
            speak(text)
        finally:
            _speech_q.task_done()


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
    keyboard.wait(config.HOTKEY)  # blocks until pressed
    chunks = []
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", device=config.INPUT_DEVICE,
                        callback=lambda d, *_: (chunks.append(d.copy()), on_level(_rms(d)))):
        print("[recording...]")
        on_state("listening")
        while keyboard.is_pressed(config.HOTKEY):
            time.sleep(0.02)
    return np.concatenate(chunks)[:, 0] if chunks else np.zeros(0, dtype="float32")


unsure = False  # True when the last transcription had low confidence (see WHISPER_MIN_LOGPROB)


def _hints():
    """Words Whisper should expect: the assistant name, app names and your own extras."""
    return "Words: " + ", ".join([config.ASSISTANT_NAME, *config.APP_WHITELIST, config.WHISPER_HINTS]).strip(", ") + "."


def transcribe(audio, force=False):
    global _whisper, unsure
    unsure = False
    if len(audio) < RATE * 0.3 and not force:  # under 0.3 s: accidental tap
        return ""
    peak = np.abs(audio).max() if len(audio) else 0
    if 0 < peak < 0.5 and not force:  # quiet voice: raise volume (max x8 so noise isn't blown up)
        audio = audio * min(0.7 / peak, 8)
    if _whisper is None:
        from faster_whisper import WhisperModel
        _whisper = WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
    segments, _ = _whisper.transcribe(audio, language=config.WHISPER_LANGUAGE, beam_size=config.WHISPER_BEAM,
                                      initial_prompt=_hints(), vad_filter=not force,  # force = warm-up: run the full model
                                      condition_on_previous_text=False)
    segments = [s for s in segments if not (s.no_speech_prob > 0.6 and s.avg_logprob < -0.5)]  # Whisper's silence rule
    if segments and np.mean([s.avg_logprob for s in segments]) < config.WHISPER_MIN_LOGPROB:
        unsure = True
    text = " ".join(s.text.strip() for s in segments).strip()
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


def _mic_blocks():
    """Endless stream of 0.1 s mic blocks (float32 mono 16 kHz). Close it to release the mic."""
    n = int(RATE * 0.1)
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=n, device=config.INPUT_DEVICE) as s:
        while True:
            block = s.read(n)[0][:, 0].copy()
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
    *lead, name = config.WAKE_PHRASE.lower().split()  # e.g. ["hey"], "raphael"
    words = text.split()

    def like(word, target, cutoff):
        return difflib.SequenceMatcher(None, re.sub(r"\W", "", word.lower()), target).ratio() >= cutoff

    # Name as the 1st word, or the 2nd after ANY word: Whisper often mishears "hey" as "here", "now", "hay"...
    # A name later in the sentence ("I told Raphael...") is ignored.
    for i, w in enumerate(words[:len(lead) + 1]):
        if like(w, name, 0.75):
            return " ".join(words[i + 1:]).strip(" ,.!?")
    return None


awake_until = 0.0


def stay_awake():
    """Call after a reply: for WAKE_FOLLOWUP_SECONDS the next phrase needs no wake phrase."""
    global awake_until
    awake_until = time.time() + config.WAKE_FOLLOWUP_SECONDS


def listen_for_wake_phrase(blocks=None):
    """Transcribe each utterance; return the command that follows 'hey raphael' (asks for it if not said yet)."""
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
            if command is None and awake and text:
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
    transcribe(np.zeros(RATE, dtype="float32") + 0.001 * np.random.randn(RATE).astype("float32"), force=True)
    if config.WAKE_WORD_ENABLED and not config.WAKE_PHRASE:
        wait_for_wake_word(frames=[np.zeros(1280, dtype="int16")])


def _sure(text):
    """Text, or "" if the last transcription was low confidence (voice.unsure stays True)."""
    return "" if unsure else text


def listen():
    if config.WAKE_WORD_ENABLED:
        if config.WAKE_PHRASE:
            return listen_for_wake_phrase()
        wait_for_wake_word()
        return _sure(transcribe(record_until_silence()))
    return _sure(transcribe(record()))


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
