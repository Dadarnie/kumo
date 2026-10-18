import ast
import json
import re
import sys
import time

from openai import OpenAI, OpenAIError

import config
import reminders
import tools
import vault

for stream in (sys.stdout, sys.stderr):  # a title or reply with an emoji must never crash printing on a Windows code page
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(errors="replace")

client = OpenAI(base_url=config.BASE_URL, api_key=config.API_KEY)


def trim(history):
    """Keep the last HISTORY_TURNS user turns, cutting only at a user message."""
    users = [i for i, m in enumerate(history) if m["role"] == "user"]
    if len(users) > config.HISTORY_TURNS:
        del history[: users[-config.HISTORY_TURNS]]


SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
# "Let me read it", "I will copy that", "I'll check" said instead of calling a tool (questions to the user don't count)
PROMISE = re.compile(r"\b(let me|allow me|i will|i'll|i am going to|i'm going to|i need to|i can now|one moment|"
                     r"please wait|i await)\b(?![^?]*\?)", re.I)
# computed once at startup: what is really installed + what Raphael remembers from the Obsidian vault
SYSTEM = config.SYSTEM_PROMPT + tools.environment_note() + vault.memory_prompt()
EXTRA = {"reasoning_effort": config.REASONING_EFFORT} if config.REASONING_EFFORT else {}


def text_tool_call(content):
    """'play_music(query="x")' written as plain text (alone on a line, maybe in `backticks`)
    -> ("play_music", {"query": "x"}); None if no line is a known tool call."""
    for line in content.splitlines():
        line = line.strip().strip("`").strip()
        if not re.match(r"\w+\(.*\)$", line):
            continue
        try:  # double the backslashes so Windows paths like 'C:\Users' parse as plain text
            call = ast.parse(line.replace("\\", "\\\\"), mode="eval").body
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id in tools.FUNCS and not call.args:
                return call.func.id, {k.arg: ast.literal_eval(k.value) for k in call.keywords}
        except (SyntaxError, ValueError):
            pass
    return None


def warm_llm():
    """One tiny request: loads the model if LM Studio unloaded it, and primes the prompt."""
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "hi"}]
    client.chat.completions.create(model=config.MODEL, messages=messages, tools=tools.TOOLS, max_tokens=1, **EXTRA)


def ask(history, text, on_sentence=None, stop=None):
    """Send one user message, stream the reply, run any tool calls. on_sentence(s) gets each finished sentence.
    stop: optional threading.Event (barge-in) that ends the reply early."""
    history.append({"role": "user", "content": text})
    trim(history)
    nudged = False
    stopped = lambda: tools.cancel.is_set() or (stop is not None and stop.is_set())
    for round_no in range(config.MAX_TOOL_ROUNDS):
        if stopped():
            print("(stopped)")
            return ""
        messages = [{"role": "system", "content": SYSTEM}, *history]
        content, buf, calls = "", "", {}
        for chunk in client.chat.completions.create(model=config.MODEL, messages=messages, tools=tools.TOOLS, stream=True,
                                                    max_tokens=config.MAX_REPLY_TOKENS, **EXTRA):
            if stopped():
                break
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                content += delta.content
                print(delta.content, end="", flush=True)
                if on_sentence:
                    *done, buf = SENTENCE_END.split(buf + delta.content)
                    for s in done:
                        on_sentence(s)
            for tc in delta.tool_calls or []:  # name/arguments arrive in pieces
                c = calls.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                c["id"] = tc.id or c["id"]
                if tc.function:
                    c["name"] += tc.function.name or ""
                    c["args"] += tc.function.arguments or ""
        print()
        if not calls and (tc := text_tool_call(content)):  # small model wrote the call as text: run it, don't speak it
            calls[0] = {"id": "text_call", "name": tc[0], "args": json.dumps(tc[1])}
            content = buf = ""
        if on_sentence and buf.strip():
            on_sentence(buf)
        msg = {"role": "assistant"}
        if content:
            msg["content"] = content
        if calls:
            msg["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["args"]}}
                                 for c in calls.values()]
        history.append(msg)
        if not calls and not nudged and round_no == 0 and (PROMISE.search(content) or any(n in content for n in tools.FUNCS)):
            # small model said "let me read it" / "I will copy it" but called no tool: push it once to actually act
            nudged = True
            history.append({"role": "user", "content": "(Do it now: call the tool instead of saying you will.)"})
            continue
        if not calls:
            return content
        for c in calls.values():
            try:
                args = json.loads(c["args"] or "{}")
            except json.JSONDecodeError:
                args = {}
            print(f"[tool] {c['name']}({args})")
            result = tools.run_tool(c["name"], args)
            print(f"[tool result] {result[:200]}")
            history.append({"role": "tool", "tool_call_id": c["id"], "content": result})
    print(f"(stopped: more than {config.MAX_TOOL_ROUNDS} tool steps)")
    return ""


def main():
    if "--models" in sys.argv:
        print("\n".join(m.id for m in client.models.list()))
        return
    use_ui = "--ui" in sys.argv
    voice_mode = use_ui or "--voice" in sys.argv
    if voice_mode:
        import voice
    if use_ui:
        import threading
        import ui
        app = ui.App()
        voice.on_state = app.set_state
        tools.approver = app.ask_approval  # Allow/Deny buttons in the window
        voice.on_heard = lambda text, woke: None if woke else app.note(f"ignored: {text}  (start with '{config.WAKE_PHRASE}')")
        voice.on_level = app.level            # Voice panel: mic bars
        voice.on_speak = app.speak_envelope   # Voice panel: Raphael's speech bars
        tools.on_activity = app.activity      # Activity panel: every tool step
        app.on_text = voice.typed.put         # "Type to Raphael" box
        app.on_toggle_mute = voice.toggle_mute
        voice.on_mute = app.set_muted
        if config.WAKE_WORD_ENABLED and config.WAKE_PHRASE:
            app.note("I'm listening. Just talk." if config.ALWAYS_LISTEN else
                     f"Say '{config.WAKE_PHRASE}' and then your request.")
        threading.Thread(target=converse, args=(voice_mode, app), daemon=True).start()
        print(f"{config.ASSISTANT_NAME} window open. Confirmations (y/n) are asked in this terminal.")
        app.mainloop()
        save_session()  # window closed: write today's session summary to Obsidian
    else:
        converse(voice_mode)


TRANSCRIPT = []  # (who, text) for this run, summarized into the Obsidian daily note at the end
_saved = []


def save_session():
    """Summarize this run into raphael/daily/YYYY-MM-DD.md (once). Skipped if nothing was asked."""
    if _saved or not any(who == "you" for who, _ in TRANSCRIPT):
        return
    _saved.append(True)
    convo = "\n".join(f"{who}: {text}" for who, text in TRANSCRIPT[-40:])
    try:
        r = client.chat.completions.create(model=config.MODEL, max_tokens=300, **EXTRA, messages=[
            {"role": "system", "content": "You write short, factual session logs."},
            {"role": "user", "content": "Summarize this conversation between the user and Raphael (their assistant) for "
                                        "the user's Obsidian daily log: 2 to 6 short bullet points starting with '- ': what "
                                        "was asked, what was done, open follow-ups. No preamble.\n\n" + convo}])
        rel = vault.save_daily_note(r.choices[0].message.content or "")
        print(f"(session summary saved to {rel} in your vault)")
    except Exception as e:  # never block closing
        print(f"(could not save the session summary: {e})")


def start_reminders(voice_module=None, app=None):
    """Due reminders: spoken, shown in the HUD, and sent as a Windows notification."""
    def fire(text, late):
        message = f"Reminder{' (missed while I was off)' if late else ''}: {text}"
        print(f"\n[{message}]")
        reminders.notify(config.ASSISTANT_NAME, message)
        if app:
            app.note(message)
            app.activity("⏰", message)
        if voice_module:
            voice_module.speak_async(message)
    reminders.on_fire = fire
    reminders.start()


LLM_DOWN = f"Cannot reach LM Studio at {config.BASE_URL}.\nStart the server in LM Studio and load the model."


def converse(voice_mode, app=None):
    history = []
    name = config.ASSISTANT_NAME
    if voice_mode:
        import voice
        tools.announce = voice.speak_async
        try:
            import keyboard
            keyboard.add_hotkey(config.MUTE_HOTKEY, voice.toggle_mute)
        except Exception as e:
            print(f"(mute hotkey {config.MUTE_HOTKEY} not set: {e})")
        print(f"{name} voice mode ({config.MODEL}). Hold '{config.HOTKEY}' to talk, say 'exit' or Ctrl+C to quit.")
    else:
        print(f"{name} ({config.MODEL}). Type 'exit' to quit.")
    try:
        print("Loading models...", flush=True)
        if app:
            app.set_state("thinking")
        t = time.time()
        warm_llm()
        if voice_mode:
            voice.preload()
        print(f"Ready ({time.time() - t:.1f}s).")
        start_reminders(voice if voice_mode else None, app)
        while True:
            if app:
                app.set_state("idle")
            try:
                text = voice.listen() if voice_mode else input("\nyou> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if voice_mode and not text and voice.unsure:
                print("(low confidence, asked to repeat)")
                voice.speak_async("Sorry, I didn't catch that. Please say it again.")
                voice.wait_speaking()
            if voice_mode and text:
                print(f"you> {text}")
            if text.lower().strip(" .!") in ("exit", "quit"):
                break
            if text:
                if app:
                    app.set_state("thinking")
                    app.show(you=text, reply="")
                print(f"{name.lower()}> ", end="")

                def say(sentence):  # speak while the model is still writing
                    if app:
                        app.set_state("speaking")
                    voice.speak_async(sentence)

                tools.cancel.clear()
                if voice_mode:
                    voice.interrupted.clear()
                reply = ask(history, text, say if voice_mode else None, voice.interrupted if voice_mode else None)
                TRANSCRIPT.extend([("you", text), ("raphael", reply)])
                if app:
                    app.show(reply=reply)
                if voice_mode:
                    voice.wait_speaking()
                    if voice.interrupted.is_set() and app:
                        app.note("(you interrupted; go ahead)")
                    voice.stay_awake()  # follow-up window starts when she finishes talking
    except OpenAIError as e:
        print(f"{LLM_DOWN}\n({e})")
    finally:
        if app:
            app.close()  # main() saves the session summary once the window is gone
        else:
            save_session()


if __name__ == "__main__":
    try:
        main()
    except OpenAIError as e:
        sys.exit(f"{LLM_DOWN}\n({e})")
