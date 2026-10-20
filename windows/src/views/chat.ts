// SPDX-License-Identifier: MIT
// Mimo's conversation, file attachments and voice controls.

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
import { VoiceChat } from "./voice-chat";
import { voiceCommand } from "../core/voice-commands";

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

export function buildPrompt(onHeightChange: () => void, actions?: ViewActions): ViewHost {
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
  const voice = new VoiceChat(async transcript => {
    const command = voiceCommand(transcript);
    if (command && actions) {
      voice.cancel();
      if (Activity.voice.active) actions.closeVoice();
      if (command === "stop") return;
      if (command === "settings") actions.openSettingsWindow("chat");
      else if (command === "home") actions.setView("overview");
      else if (command === "limits") actions.setView("usage");
      return;
    }
    return submit(true, transcript.trim());
  }, () => {
    if (Activity.voice.active && voice.voiceConnection)
      Activity.describeVoice(voice.voiceConnection.name, voice.voiceConnection.chatName ?? chatAssistantName(State.settings));
    if (Activity.voice.active && Activity.voice.phase !== "paused")
      Activity.setVoice(true, voice.currentPhase === "idle" && State.chatError ? "error" : voice.currentPhase, State.chatError || null);
    State.notify(); onHeightChange();
  }, message => {
    State.chatError = message;
    if (Activity.voice.active) Activity.setVoice(true, "error", message);
    Sound.play("error");
    State.notify(); onHeightChange();
  }, async () => {
    if (!sending || (!spokenTurn && !Activity.voice.active)) return;
    cancelledTurn = true;
    ++turnRevision;sending = false;spokenTurn = false;
    State.stateOverride = null;
    Activity.chat.busy = false;
    await Bridge.chatCancel();
  });
  const bar = h("div", { class: "chat-bar" }, input, voice.button, send);
  const errorText = h("span");
  const error = h("div", { class: "chat-error", role: "alert", hidden: true }, errorText,
    h("button", { type: "button", title: "Dismiss error", "aria-label": "Dismiss error",
      onclick: () => { State.chatError = ""; State.notify(); } }, icon(ICONS.xmark, 11)));
  const dropHint = h("p", { class: "chat-drop-hint", role: "status", text: "Drop up to 5 files to attach them", hidden: true });

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, log, chipRow, error, picker.el, voice.status, bar, dropHint)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let turnRevision = 0;
  let spokenTurn = false;
  let cancelledTurn = false;
  let voicePreferences = `${State.settings.voiceProvider}|${State.settings.voiceRepliesEnabled}|${State.chatConnectionsVersion}`;
  let generation = State.chatEpoch;
  let disposed = false;
  let renderedCount = -1;

  async function submit(spoken = false, transcript?: string): Promise<string | undefined> {
    const query = (transcript ?? input.value).trim();
    if (!query || sending || disposed || State.chatAttachmentLoading || picker.busy || (!spoken && voice.busy)) return;
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
    if (!spoken) { input.value = ""; State.chatDraft = ""; }
    State.chatError = "";
    sending = true;
    spokenTurn = spoken;
    cancelledTurn = false;
    Activity.chatStarted();
    const activityChat = Activity.chat;
    const epoch = State.chatEpoch;
    const revision = ++turnRevision;
    if (!spoken || !Activity.voice.active) Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query, ...(files.length ? { attachments: files.map(file => file.name) } : {}) });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    try {
      const reply = await Bridge.chatSend(query, context, Activity.voice.active);
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
      spokenTurn = false;
      State.notify();
      onHeightChange();
      if (State.view === "prompt") input.focus({ preventScroll: true });
    }
  }

  send.addEventListener("click", () => void submit());
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
    voice,
    tick() { picker.place(); },
    sync() {
      const preferences = `${State.settings.voiceProvider}|${State.settings.voiceRepliesEnabled}|${State.chatConnectionsVersion}`;
      if (preferences !== voicePreferences) { voicePreferences = preferences; voice.cancel(); }
      if (generation !== State.chatEpoch) {
        generation = State.chatEpoch;
        sending = false;
        renderedCount = -1;
        voice.cancel();
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

      const thinking = State.stateOverride === "thinking";
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
      picker.el.inert = voice.busy;

      const assistant = chatAssistantName(State.settings);
      input.placeholder = State.chatHistory.length === 0 ? "Ask " + assistant + "…" : "Continue…";
      input.setAttribute("aria-label", "Ask " + assistant);
      el.setAttribute("aria-label", assistant + " chat");
      send.title = "Ask " + assistant;
      send.setAttribute("aria-label", send.title);
      input.disabled = sending || picker.busy || voice.busy;
      send.disabled = sending || picker.busy || !!loading || voice.busy;
      voice.button.disabled = !voice.busy && (sending || picker.busy || !!loading);
    },
    focus() {
      input.focus({ preventScroll: true });
      input.select();
    },
    setVisible(visible) { if (!visible && !Activity.voice.active) voice.cancel(); },
    destroy() { disposed = true; voice.cancel(); picker.destroy(); input.value = ""; },
  };
}
