// SPDX-License-Identifier: MIT
import { Bridge } from "../core/bridge";
import { CHAT_PROVIDERS, chatDefinition, validChatModel, type ChatProvider } from "../core/chat-providers";
import { State, normalizeSettings } from "../core/state";
import { CompactDropdown } from "./device-picker";
import { h } from "./dom";
import { ICONS, icon } from "./icons";

const PROVIDER_LABELS: Record<ChatProvider, string> = {
  anthropic: "Anthropic", gemini: "Google", openai: "OpenAI", openrouter: "OpenRouter", ollama: "Local", xai: "Grok", groq: "Groq",
};
let sequence = 0;

/** Uses the shell's listbox and popover patterns; credentials never enter this view. */
export class ChatPicker {
  private label = h("span", { class: "chat-model-name" });
  private mark = h("i", { class: "chat-provider-dot" });
  private buttons = new Map<ChatProvider, HTMLButtonElement>();
  private connections: Partial<Record<ChatProvider, boolean>> | null = null;
  private connectionVersion = -1;
  private connectionRequest = 0;
  private active = false;
  private disposed = false;
  private switching = false;
  private model: CompactDropdown;
  private draft = h("input", { type: "text", maxlength: 160, autocomplete: "off", spellcheck: "false", placeholder: "Model ID", "aria-label": "Chat model ID" });
  private feedback = h("span", { class: "chat-custom-feedback", role: "status" });
  private custom: HTMLDivElement;
  private hint = h("p", { class: "chat-picker-hint", role: "status", hidden: true });
  readonly button: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  readonly el: HTMLDivElement;

  constructor(private beforeSelect: () => void) {
    const id = `chat-models-${++sequence}`;
    this.feedback.id = `${id}-feedback`;
    this.draft.setAttribute("aria-describedby", this.feedback.id);
    this.button = h("button", {
      type: "button", class: "chat-model-toggle", "aria-label": "Choose AI and model",
      "aria-expanded": "false", "aria-controls": id, "aria-haspopup": "dialog", popovertarget: id,
    }, this.mark, this.label, icon(ICONS.chevronDown, 10));
    const providers = h("div", { class: "chat-providers", role: "group", "aria-label": "Chat provider" });
    for (const { id: provider } of CHAT_PROVIDERS) {
      const button = h("button", {
        type: "button", class: "chat-provider", "data-chat-provider": provider, "aria-pressed": "false",
        onclick: () => void this.select(provider, State.settings.chatModels[provider], false),
      }, h("i", { class: "chat-provider-dot" }), h("span", { text: PROVIDER_LABELS[provider] }));
      this.buttons.set(provider, button);
      providers.append(button);
    }
    providers.append(h("button", {
      type: "button", class: "chat-manage-keys", title: "Manage API keys in Settings", "aria-label": "Manage API keys in Settings",
      onclick: () => { this.close(); void Bridge.openSettingsWindow("chat"); },
    }, icon(ICONS.gear, 13)));
    this.model = new CompactDropdown("Chat model", "chat-model-select", value => {
      if (value === "custom") {
        this.custom.hidden = false;
        this.draft.value = State.settings.chatModels[State.settings.chatProvider];
        this.feedback.textContent = "";
        this.draft.removeAttribute("aria-invalid");
        this.place();
        this.draft.focus({ preventScroll: true });
        this.draft.select();
      } else return this.select(State.settings.chatProvider, value, true);
    });
    this.custom = h("div", { class: "chat-custom-model", hidden: true },
      h("span", { class: "chat-custom-label", text: "Custom model" }),
      h("div", { class: "chat-custom-row" }, this.draft,
        h("button", { type: "button", class: "chat-use-model", text: "Use model", onclick: () => void this.chooseCustom() })), this.feedback);
    this.panel = h("div", { id, class: "chat-model-panel", popover: "auto", role: "dialog", "aria-label": "Choose AI and model" }, providers, this.model.el, this.custom, this.hint);
    this.el = h("div", { class: "chat-model-row" }, this.button, this.panel);
    this.button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (this.panel.matches(":popover-open")) this.close();
      else this.open();
    });
    this.panel.addEventListener("toggle", () => {
      this.button.setAttribute("aria-expanded", String(this.panel.matches(":popover-open")));
    });
    this.panel.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        this.button.focus();
      }
    });
    this.draft.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void this.chooseCustom();
      }
    });
    this.draft.addEventListener("input", () => {
      this.draft.removeAttribute("aria-invalid");
      this.feedback.textContent = "";
      this.place();
    });
  }

  get busy(): boolean { return this.switching; }

  sync(): void {
    if (this.disposed) return;
    const active = State.view === "prompt";
    if (!active) this.close();
    if (active && (!this.active || this.connectionVersion !== State.chatConnectionsVersion)) void this.refreshConnections();
    this.active = active;
    const provider = State.settings.chatProvider;
    const definition = chatDefinition(provider);
    const selected = State.settings.chatModels[provider];
    this.button.dataset.chatProvider = provider;
    this.label.textContent = definition.models.find(([id]) => id === selected)?.[1] ?? selected;
    this.button.title = "Choose AI and model · " + PROVIDER_LABELS[provider] + ". Switching starts a new chat; your draft and attachment stay.";
    this.button.disabled = this.switching || !!State.chatAttachmentLoading;
    for (const [id, button] of this.buttons) {
      const connected = this.connections?.[id] === true || id === "ollama";
      button.disabled = this.button.disabled || !connected;
      button.setAttribute("aria-pressed", String(id === provider));
      button.title = connected ? "Use " + chatDefinition(id).name : "Add a " + PROVIDER_LABELS[id] + " API key in Settings";
    }
    const choices: { id: string; name: string }[] = definition.models.map(([id, name]) => ({ id, name }));
    if (!choices.some(option => option.id === selected)) choices.push({ id: selected, name: selected });
    choices.push({ id: "custom", name: "Other model…" });
    this.model.update(choices, selected, !this.button.disabled && (provider === "ollama" || this.connections?.[provider] === true));
    this.draft.disabled = this.switching;
    this.custom.querySelector<HTMLButtonElement>("button")!.disabled = this.switching;
    this.hint.hidden = provider !== "ollama" && (this.connections === null || this.connections[provider] === true);
    this.hint.textContent = provider === "ollama" ? "Install your chosen model in Ollama first."
      : "Add a " + PROVIDER_LABELS[provider] + " key in Settings, or choose Local.";
    this.place();
  }

  close(): void {
    this.model.close();
    if (this.panel.matches(":popover-open")) this.panel.hidePopover();
    this.button.setAttribute("aria-expanded", "false");
    this.custom.hidden = true;
    this.draft.value = "";
    this.feedback.textContent = "";
    this.draft.removeAttribute("aria-invalid");
  }

  destroy(): void {
    this.disposed = true;
    this.connectionRequest++;
    this.close();
  }

  private open(): void {
    this.sync();
    this.panel.showPopover();
    this.button.setAttribute("aria-expanded", "true");
    this.place();
    (this.buttons.get(State.settings.chatProvider)?.disabled
      ? this.panel.querySelector<HTMLButtonElement>("button:not(:disabled)")
      : this.buttons.get(State.settings.chatProvider))?.focus();
    void this.refreshConnections();
  }

  /** Follows shell geometry on the existing view clock, only while open. */
  place(): void {
    if (!this.panel.matches(":popover-open")) return;
    const bar = this.el.closest(".chat-body")?.querySelector(".chat-bar");
    const card = this.el.closest(".chat-card");
    if (!bar || !card) return;
    const rect = bar.getBoundingClientRect();
    const trigger = this.button.getBoundingClientRect();
    this.panel.style.width = `${rect.width}px`;
    this.panel.style.left = `${rect.left}px`;
    this.panel.style.top = `${Math.max(card.getBoundingClientRect().top + 8, trigger.top - this.panel.getBoundingClientRect().height - 6)}px`;
  }

  private async refreshConnections(): Promise<void> {
    this.connectionVersion = State.chatConnectionsVersion;
    const request = ++this.connectionRequest;
    const connections = await Bridge.chatConnections();
    if (this.disposed || request !== this.connectionRequest) return;
    this.connections = connections;
    this.sync();
  }

  private async chooseCustom(): Promise<void> {
    const provider = State.settings.chatProvider;
    const value = this.draft.value.trim();
    if (!validChatModel(provider, value)) {
      this.draft.setAttribute("aria-invalid", "true");
      this.feedback.textContent = provider === "openrouter" ? "Use openrouter/free or a model ending in :free."
        : provider === "ollama" ? "Enter a local model ID. Cloud models are disabled." : "Enter a valid model ID.";
      this.place();
      return;
    }
    await this.select(provider, value, true);
  }

  private async select(provider: ChatProvider, model: string, close: boolean): Promise<void> {
    if (this.disposed || this.switching || State.chatAttachmentLoading
      || (provider !== "ollama" && this.connections?.[provider] !== true)) return;
    if (provider === State.settings.chatProvider && model === State.settings.chatModels[provider]) {
      if (close) this.close();
      return;
    }
    this.beforeSelect();
    this.switching = true;
    State.chatError = "";
    State.notify();
    try {
      const settings = normalizeSettings(await Bridge.chatSelect(provider, model));
      if (this.disposed) return;
      // The native settings event may already have applied this selection.
      if (State.settings.chatProvider !== settings.chatProvider
        || JSON.stringify(State.settings.chatModels) !== JSON.stringify(settings.chatModels)) State.clearChat(true);
      State.settings = settings;
      this.custom.hidden = true;
      if (close) this.close();
    } catch (error) {
      if (!this.disposed) State.chatError = String(error).replace(/^Error:\s*/, "");
    } finally {
      if (!this.disposed) {
        this.switching = false;
        this.sync();
        State.notify();
        if (document.activeElement === document.body) {
          if (close) this.button.focus();
          else if (this.panel.matches(":popover-open")) this.buttons.get(State.settings.chatProvider)?.focus();
        }
      }
    }
  }
}
