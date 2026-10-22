// SPDX-License-Identifier: MIT
// Kumo's conversation and file attachments. With Kumo on, typed requests go to
// Kumo and the log shows its spoken and typed turns (island/assistant.ts).

import { h, clear } from "./dom";
import { ICONS, icon } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import { chatAssistantName } from "../core/coding";
import type { ViewHost, ViewActions } from "./views";
import { ChatPicker } from "./chat-picker";
import "./chat.css";
import { Activity } from "../core/activity";
import { renderMarkdown } from "./markdown";
import { Assistant, stopAssistant } from "../island/assistant";
import { CompactDropdown } from "./device-picker";

let nextId = 1;

function attachmentMark(): HTMLElement {
  return h("span", { class: "chat-attachment-mark", "aria-hidden": "true" });
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble" },
        ...(message.attachments ?? (message.attachment ? [message.attachment] : [])).map(name =>
          h("span", { class: "chat-sent-file" }, attachmentMark(), h("span", { text: name }))),
        h("span", { text: message.content })),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply chat-markdown" }, renderMarkdown(message.content)));
}

function typingDots(): HTMLElement {
  return h("div", { class: "chat-row" }, h("div", { class: "typing" }, h("i"), h("i"), h("i")));
}

function contextChip(label: string, loading: boolean, index?: number): HTMLElement {
  return h(
    "div",
    { class: "chip settled chat-attachment", "aria-busy": String(loading) },
    attachmentMark(),
    h("span", { text: (loading ? "Attaching " : "") + label + (loading ? "…" : ""), title: label }),
    h("button", { type: "button", class: "chat-remove-attachment", title: `Remove ${label}`, "aria-label": `Remove ${label}`,
      onclick: () => {
        State.chatAttachmentVersion++;
        State.chatAttachmentLoading = null;
        if (index !== undefined) State.droppedFiles.splice(index, 1);
        State.promptContext = null;
        State.chatError = ""; State.notify();
      } }, icon(ICONS.xmark, 10)),
  );
}

export function buildPrompt(onHeightChange: () => void, _actions?: ViewActions): ViewHost {
  const chipRow = h("div", { class: "chip-row", role: "status" });
  const log = h("div", { class: "chat-log", role: "log", "aria-label": "Conversation", "aria-live": "polite" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    "aria-label": "Message Kumo",
    placeholder: "Ask me anything…",
    spellcheck: "false",
    maxlength: 32000,
  }) as HTMLInputElement;
  input.value = State.chatDraft;
  const picker = new ChatPicker(() => { State.chatDraft = input.value; });
  const send = h("button", { type: "button", class: "send-btn", title: "Send", "aria-label": "Send message" }, icon(ICONS.arrowUp, 14));
  // Mic: the assistant takes your next phrase as a request (English or Tagalog), even when muted.
  const mic = h("button", { type: "button", class: "chat-mic", title: "Talk to Kumo", "aria-label": "Talk to Kumo" },
    icon(ICONS.microphone, 16), h("span", { class: "chat-mic-stop", "aria-hidden": "true" }));
  const bars = h("span", { class: "chat-level", "aria-hidden": "true" }, ...[0, 1, 2, 3, 4].map(() => h("i")));
  const listeningRow = h("div", { class: "chat-listening", role: "status", hidden: true }, bars,
    h("span", { text: "Listening… tap the mic to stop" }));
  const bar = h("div", { class: "chat-bar" }, mic, input, send);
  // Which Ollama model the assistant runs; switching restarts it (about a minute).
  let models: string[] = [];
  let switching = "";
  const modelPicker = new CompactDropdown("Assistant model", "chat-assistant-model", async base => {
    switching = base;
    State.chatError = "";
    State.notify();
    try { await Bridge.assistantUseModel(base); }
    catch (e) { State.chatError = String(e).replace(/^Error:\s*/, ""); }
    finally { switching = ""; State.notify(); }
  });
  const modelRow = h("div", { class: "chat-model-row chat-assistant-models" }, modelPicker.el);
  const loadModels = async () => { models = (await Bridge.assistantModels().catch(() => null)) ?? []; State.notify(); };
  const suggestions = ["What's new in AI?", "Any free dev tools today?", "Remind me in 20 minutes to stretch"];
  const empty = h("div", { class: "chat-empty" },
    h("strong", { text: "Hi, I'm Kumo" }),
    h("span", { class: "chat-empty-hint", text: "Type, or tap the mic and talk. English or Tagalog." }),
    h("div", { class: "chat-suggestions" }, ...suggestions.map(text =>
      h("button", { type: "button", class: "chat-suggestion", text, onclick: () => { input.value = text; void submit(); } }))));
  const errorText = h("span");
  const error = h("div", { class: "chat-error", role: "alert", hidden: true }, errorText,
    h("button", { type: "button", title: "Dismiss error", "aria-label": "Dismiss error",
      onclick: () => { State.chatError = ""; State.notify(); } }, icon(ICONS.xmark, 11)));
  const dropHint = h("p", { class: "chat-drop-hint", role: "status", text: "Drop up to 5 files to attach them", hidden: true });

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card chat-card" }, h("div", { class: "chat-body" }, empty, log, chipRow, error, picker.el, modelRow, listeningRow, bar, dropHint)),
  );

  let sending = false;
  let turnRevision = 0;
  let cancelledTurn = false;
  let listening = false;
  let listenTimer: ReturnType<typeof setTimeout> | undefined;
  let listenFrame = 0;
  let heardCount = 0;
  const stopListening = (tell: boolean) => {
    if (!listening) return;
    listening = false;
    clearTimeout(listenTimer);
    cancelAnimationFrame(listenFrame);
    if (tell) void Bridge.assistantSend({ t: "listen_stop" });
    State.notify();
  };
  const animateLevel = () => {
    const level = Math.min(1, Assistant.level * 14);
    [...bars.children].forEach((bar, i) => {
      (bar as HTMLElement).style.height = `${4 + Math.round(level * [8, 12, 10, 14, 7][i])}px`;
    });
    if (listening) listenFrame = requestAnimationFrame(animateLevel);
  };
  mic.addEventListener("click", () => {
    if (listening) { stopListening(true); return; }
    if (!Assistant.ready) { State.chatError = "Kumo is starting. Try again in a moment."; State.notify(); return; }
    listening = true;
    heardCount = State.chatHistory.length;
    State.chatError = "";
    Sound.play("tick");
    void Bridge.assistantSend({ t: "listen" });
    listenTimer = setTimeout(() => stopListening(true), 30_000);
    listenFrame = requestAnimationFrame(animateLevel);
    State.notify();
  });
  let generation = State.chatEpoch;
  let disposed = false;
  let renderedCount = -1;

  /** Kumo answers by voice and events; the reply arrives in the log on its own. */
  function askAssistant(query: string): void {
    if (State.droppedFiles.length) State.chatError = "Kumo can't read attached files yet. Remove them first.";
    else if (!Assistant.ready) State.chatError = "Kumo is starting. Try again in a moment.";
    else if (query.length > 4000) State.chatError = "Enter a message shorter than 4,000 characters.";
    else {
      input.value = ""; State.chatDraft = ""; State.chatError = "";
      Sound.play("send");
      void Bridge.assistantSend({ t: "text", v: query });
    }
    State.notify();
  }

  async function submit(): Promise<string | undefined> {
    const query = input.value.trim();
    if (!query || sending || disposed || State.chatAttachmentLoading || picker.busy) return;
    if (State.settings.assistantEnabled) { askAssistant(query); return; }
    if (new TextEncoder().encode(query).length > 32_000) {
      State.chatError = "Enter a message shorter than 32 KB.";
      State.notify();
      return;
    }
    const files = State.droppedFiles.map(file => ({ ...file }));
    const attachmentVersion = State.chatAttachmentVersion;
    const context: ChatContext | null = files.length
      ? files.length === 1 ? { kind: "file", ...files[0] } : { kind: "files", files }
      : State.promptContext?.kind === "window" ? State.promptContext : null;
    picker.close();
    input.value = ""; State.chatDraft = "";
    State.chatError = "";
    sending = true;
    cancelledTurn = false;
    Activity.chatStarted();
    const activityChat = Activity.chat;
    const epoch = State.chatEpoch;
    const revision = ++turnRevision;
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query, ...(files.length ? { attachments: files.map(file => file.name) } : {}) });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    try {
      const reply = await Bridge.chatSend(query, context);
      if (disposed || epoch !== State.chatEpoch || revision !== turnRevision || cancelledTurn) return;
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      Activity.chatFinished();
      if (attachmentVersion === State.chatAttachmentVersion) State.clearAttachment();
      State.stateOverride = null;
      Sound.play("finish");
      return reply.text;
    } catch (err) {
      if (disposed || epoch !== State.chatEpoch || revision !== turnRevision || cancelledTurn) return;
      State.stateOverride = null;
      State.chatError = String(err).replace(/^Error:\s*/, "");
      Activity.chat.busy = false;
      if (!input.value) input.value = query;
      State.chatDraft = input.value;
      Sound.play("error");
    } finally {
      if(Activity.chat===activityChat)Activity.chat.busy=false;
      if (disposed || epoch !== State.chatEpoch || revision !== turnRevision) return;
      sending = false;
      State.notify();
      onHeightChange();
      if (State.view === "prompt") input.focus({ preventScroll: true });
    }
  }

  send.addEventListener("click", () => {
    if (State.settings.assistantEnabled && Assistant.busy && !input.value.trim()) { stopAssistant(); return; }
    void submit();
  });
  input.addEventListener("input", () => { State.chatDraft = input.value; });
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    tick() { picker.place(); },
    sync() {
      if (generation !== State.chatEpoch) {
        generation = State.chatEpoch;
        sending = false;
        renderedCount = -1;
        input.value = State.chatDraft;
      }
      const files = State.droppedFiles;
      const loading = State.chatAttachmentLoading;
      const wantChip = JSON.stringify([loading, files]);
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        files.forEach((file, index) => chipRow.append(contextChip(file.name, false, index)));
        if (loading) chipRow.append(contextChip(loading, true));
      }
      error.hidden = !State.chatError;
      errorText.textContent = State.chatError;
      dropHint.hidden = !State.fileDragOver;
      el.querySelector(".chat-card")!.classList.toggle("is-drag-over", State.fileDragOver);

      const voiceAssistant = State.settings.assistantEnabled;
      // Your words arrived (or Kumo started answering): the mic's job is done.
      if (listening && State.chatHistory.length > heardCount) stopListening(false);
      const starting = voiceAssistant && !Assistant.ready;
      const thinking = State.stateOverride === "thinking" || (voiceAssistant && Assistant.ready && Assistant.busy && !listening);
      empty.hidden = State.chatHistory.length > 0 || thinking;
      mic.hidden = !voiceAssistant;
      mic.classList.toggle("is-listening", listening);
      mic.title = listening ? "Stop listening" : "Talk to Kumo";
      mic.setAttribute("aria-label", mic.title);
      listeningRow.hidden = !listening;
      modelRow.hidden = !voiceAssistant;
      if (voiceAssistant) {
        if (!models.length) void loadModels();
        const current = State.settings.assistantModel || "gemma4-e4b-kumo";
        const variant = (name: string) => name.replace(/:latest$/, "").replace(/[:/]/g, "-") + "-kumo";
        const selected = switching || models.find(m => variant(m) === current.replace(/:latest$/, "")) || null;
        modelPicker.update(models.map(id => ({ id, name: id.replace(/:latest$/, ""), detail: switching === id ? "Preparing…" : undefined })),
          selected, !switching && models.length > 0, "No Ollama models");
      }
      // While Kumo works and the box is empty, send becomes stop.
      const stopping = voiceAssistant && Assistant.busy && !input.value.trim();
      send.classList.toggle("is-stop", stopping);
      send.title = stopping ? "Stop Kumo" : "Send";
      send.setAttribute("aria-label", send.title);
      (empty.querySelector(".chat-empty-hint") as HTMLElement).textContent = starting
        ? "Starting Kumo's model… this takes a moment after Ollama starts."
        : voiceAssistant ? "Type, or tap the mic and talk. English or Tagalog." : "Ask anything.";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      // Place the open picker after conversation and attachment layout changes,
      // so focusing a provider cannot move it between pointerdown and click.
      picker.sync();
      picker.el.hidden = voiceAssistant;

      const assistant = voiceAssistant ? "Kumo" : chatAssistantName(State.settings);
      input.placeholder = State.chatHistory.length === 0 ? "Ask " + assistant + "…" : "Continue…";
      input.setAttribute("aria-label", "Ask " + assistant);
      el.setAttribute("aria-label", assistant + " chat");
      send.title = "Ask " + assistant;
      send.setAttribute("aria-label", send.title);
      input.disabled = sending || picker.busy;
      send.disabled = (sending || picker.busy || !!loading) && !stopping;
    },
    focus() {
      input.focus({ preventScroll: true });
      input.select();
    },
    destroy() { disposed = true; stopListening(false); picker.destroy(); input.value = ""; },
  };
}
