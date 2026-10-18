// SPDX-License-Identifier: MIT
// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { normalizeSettings, type Settings } from "../core/state";
import type { IslandVisibility } from "../core/visibility";
import { h, clear } from "../views/dom";
import { ICONS, icon } from "../views/icons";
import { appearance, musicMode } from "../icons/glyphs";
import { mimoIcon } from "../icons/render";
import { applyAppearance } from "../core/appearance";
import { CompactDropdown } from "../views/device-picker";
import "../island/media.css";
import { Lifetime } from "../core/lifetime";
import { CredentialField } from "./credential-field";
import { CODING_PROVIDERS, codingDefinition } from "../core/coding";
import { questionConnection } from "../core/question-connection";
import { backAction } from "../core/navigation-sound";
import { Sound } from "../core/sound";
import { CHAT_PROVIDERS, chatDefinition, type ChatProvider } from "../core/chat-providers";
import { VOICE_PROVIDERS, type VoiceProvider } from "../core/voice-providers";
type CodingAssistant = Settings["codingAssistant"];

let settings: Settings = normalizeSettings({});
let version = "";
const refreshControls: (() => void)[] = [];
const credentials = new Map<string, CredentialField>();
const lifetime = new Lifetime();
const stop = () => { lifetime.destroy(); Sound.destroy(); refreshControls.length = 0; };
window.addEventListener("pagehide", stop, { once: true, signal: lifetime.signal });
import.meta.hot?.dispose(stop);

const root = document.getElementById("settings-root")!;
const appIcon = new URL("../assets/app-icon-ui.png", import.meta.url).href;

async function save() {
  Sound.setEnabled(settings.soundEnabled);
  Sound.setVolume(settings.soundVolume);
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(
  label: string,
  read: () => boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const el = h("button", {
    class: "switch",
    type: "button",
    role: "switch",
    "aria-label": label,
  });
  const refresh = () => {
    el.classList.toggle("on", read());
    el.setAttribute("aria-checked", String(read()));
  };
  refreshControls.push(refresh);
  refresh();
  el.addEventListener("click", () => {
    const next = !read();
    onChange(next);
    refreshControls.forEach((refresh) => refresh());
  });
  return el;
}

function preference(
  label: string,
  read: () => boolean,
  write: (v: boolean) => void,
  description = "",
): HTMLElement {
  return h(
    "div",
    { class: "preference-row" },
    h(
      "div",
      { class: "preference-copy" },
      h("span", { class: "preference-label", text: label }),
      description ? h("span", { class: "hint", text: description }) : null,
    ),
    toggle(label, read, (value) => {
      write(value);
      void save();
    }),
  );
}

function modulesSection(): HTMLElement {
  return h(
    "section",
    { class: "preferences" },
    h("h2", { text: "Modules" }),
    preference(
      "Media",
      () => settings.modules.media,
      (value) => {
        settings.modules.media = value;
      },
      "Artwork and playback controls, close at hand.",
    ),
    preference(
      "VS Code",
      () => settings.modules.vscode,
      (value) => {
        settings.modules.vscode = value;
      },
      "Keep your coding sessions in view.",
    ),
    preference(
      "Developer integrations",
      () => settings.modules.developerIntegrations,
      (value) => {
        settings.modules.developerIntegrations = value;
      },
      "Your connected services. Monitoring pauses when off.",
    ),
  );
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", {
    class: "dot",
    style: `background:${ok ? "#22c55e" : "#f4505e"}`,
  });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+")
      ? "add"
      : line.startsWith("-")
        ? "del"
        : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function codingSection(status: HookStatus, provider: CodingAssistant): HTMLElement {
  const name = codingDefinition(provider).name;
  const observer = !["claude", "codex"].includes(provider);
  const file = ["opencode", "hermes"].includes(provider) ? "Observer plugin"
    : ["codex", "cursor", "antigravity", "copilot"].includes(provider) ? "hooks.json" : "settings.json";
  const body = h("div", { class: "coding-settings-body" });
  const section = h(
    "section",
    {},
    h(
      "h2",
      {},
      statusDot(status.installed),
      h("span", { text: name }),
    ),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus(provider);
    if (!lifetime.active) return;
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(
      statusDot(status.installed),
      h("span", { text: name }),
    );
  };

  function draw() {
    body.classList.remove("danger-zone");
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? provider === "cursor" ? "Ready. Start an Agent conversation in Cursor and Mimo will follow along."
            : observer ? "Installed. Restart your coding app and enable its hooks to see activity." : "Ready. Start coding and Mimo will follow along."
          : "Bring " + name + " into Mimo. No API key needed.",
      }),
      h(
        "div",
        { class: "row" },
        h("label", { text: file }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h(
        "div",
        { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(
        h("div", {
          class: "notice warn",
          text: "The connection helper is missing. Restart Mimo to try again.",
        }),
      );
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "Restart Mimo to restore the connection helper.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(
        h("button", {
          class: "danger",
          text: "Uninstall hooks…",
          onclick: () => showPreview(false),
        }),
      );
    }
    body.append(actions,
      h("p", { class: "hint", text: provider === "cursor"
        ? "Install hooks, then start an Agent conversation in Cursor. Restart Cursor if the hooks have not loaded."
        : "Install hooks, restart your assistant in VS Code, and start coding." }),
      h("p", { class: "hint", text: observer
        ? "Mimo follows activity. Permissions and sign-in stay in " + name + "."
        : "All coding tools can stay connected. Approvals return to your terminal when Mimo can’t show them." }),
    );
    if (provider === "hermes")
      body.append(h("p", { class: "hint", text: "After installing, enable the observer: hermes plugins enable mimo-companion" }));
    if (provider === "codex")
      body.append(h("p", { class: "hint", text: "In Codex, trust Mimo in /hooks." }));
    const connection = questionConnection(provider, status.hookPath);
    const copyStatus = h("span", { class: "hint", role: "status" });
    const copy = h("button", { type: "button", text: "Copy connection", disabled: !status.hookReady,
      onclick: async () => {
        try { await navigator.clipboard.writeText(connection); copyStatus.textContent = "Copied"; }
        catch { copyStatus.textContent = "Select the connection below to copy it."; }
      } });
    body.append(h("details", { class: "connection-settings question-connection" },
      h("summary", { text: "Follow-up questions" }),
      h("p", { class: "hint", text: provider === "claude"
        ? "Claude's AskUserQuestion already works through its hooks. You can also connect the shared MCP question tool."
        : "Connect Mimo's question tool to answer this agent's follow-ups in the shared Review queue." }),
      h("p", { class: "hint", text: provider === "codex"
        ? "Add this to your Codex config.toml, then restart Codex."
        : "In your agent's MCP settings, add a local server named Mimo with this command and arguments. Use a tool timeout of at least 120 seconds, then restart the agent." }),
      h("pre", { class: "path", text: connection }), h("div", { class: "row" }, copy, copyStatus)));
    if (provider === "claude" && status.installed && status.usageReady === false) {
      body.append(h("p", { class: "hint", text: "Your status line stays yours. Share its JSON with this command for usage. Add --quiet to keep its text." }),
        h("code", { class: "path", text: status.usageCommand ?? "" }));
    }
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install, provider);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", {
          class: "notice err",
          text: String(err).replace(/^Error:\s*/, ""),
        }),
        h(
          "div",
          { class: "row" },
          h("button", {
            text: "Back",
            onclick: backAction(() => {
              clear(body);
              draw();
            }),
          }),
        ),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.classList.toggle("danger-zone", !install);
    if (!install) body.append(h("h3", { text: "Danger zone" }));
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "Review the changes to " + file + ". Your own hooks stay as they are."
          : "Only Mimo's hooks will be removed. Your own hooks stay as they are.",
      }),
      renderDiff(preview.diff),
      h(
        "div",
        { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint, provider);
        status.installed = install;
        const head = section.querySelector("h2")!;
        clear(head);
        head.append(statusDot(install), h("span", { text: name }));
        clear(body);
        body.append(
          h("div", {
            class: "notice ok",
            text: install ? "All set. Restart " + name + " and Mimo will follow along." : "Hooks removed.",
          }),
          h("span", { class: "path", text: "Backup: " + backup }),
        );
        if (provider === "codex" && install)
          body.append(h("p", { class: "hint", text: "In Codex, trust Mimo in /hooks." }));
        if (provider === "hermes" && install)
          body.append(h("p", { class: "hint", text: "Enable the observer: hermes plugins enable mimo-companion" }));
        lifetime.after(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(
          h("div", {
            class: "notice err",
            text: `Could not write: ${String(err)}`,
          }),
        );
      }
    });
    body.append(
      h(
        "div",
        { class: "row" },
        confirm,
        h("button", {
          text: "Cancel",
          onclick: () => {
            clear(body);
            draw();
          },
        }),
      ),
    );
  }

  draw();
  return section;
}

// ── Chat credentials ──────────────────────────────────────────────────────────

function apiSection(hasKey: boolean, provider: ChatProvider): HTMLElement {
  const definition = chatDefinition(provider);
  const name = definition.name.split(" · ")[0];
  const state = h("span", { class: "chat-key-state" });
  const refreshState = (present: boolean) => {
    state.textContent = present ? "Saved" : "Not saved";
    state.title = present ? "Saved in Windows Credential Manager" : "No API key saved";
  };
  refreshState(hasKey);
  let field: CredentialField | null = null;
  if (definition.key) {
    field = new CredentialField(definition.key, name + " API key", "Paste API key", true, hasKey, refreshState, "Save key");
    field.el.querySelector("label")?.append(state);
    lifetime.own(() => field?.destroy());
    credentials.set(definition.key, field);
  }
  return h("section", { class: "chat-provider-section" },
    h("div", { class: "chat-provider-heading" }, h("h2", { text: name + " chat" }),
      h("button", { class: "chat-provider-link", type: "button", text: provider === "ollama" ? "Get Ollama & Hermes 3" : "Provider details", onclick: () => void Bridge.openUrl(definition.url) })),
    h("p", { class: "hint", text: definition.hint }),
    field?.el ?? null);
}

function chatSection(present: Record<string, boolean>): HTMLElement {
  const speech = new CompactDropdown("Voice service", "settings-voice-service", value => {
    settings.voiceProvider = value as VoiceProvider;
    void save();
  });
  speech.el.classList.add("settings-picker");
  const refreshSpeech = () => speech.update(VOICE_PROVIDERS.map(provider => ({ ...provider })), settings.voiceProvider, true);
  refreshSpeech();
  refreshControls.push(refreshSpeech);
  const panels = h("div", { class: "assistant-panels" });
  for (const p of CHAT_PROVIDERS) {
    const panel = h("div", { "data-chat-provider": p.id }, apiSection(p.key ? present[p.key] ?? false : false, p.id));
    panels.append(panel);
  }
  return h("div", { class: "assistant-settings" },
    h("p", { class: "hint", text: "Save your keys here. Pick your AI in chat." }),
    h("section", { class: "preferences" }, h("h2", { text: "Voice messages" }),
      h("div", { class: "preference-row" }, h("label", { text: "Voice service" }), speech.el),
      preference("Read replies aloud", () => settings.voiceRepliesEnabled,
        value => { settings.voiceRepliesEnabled = value; }, "Mimo uses an AI generated voice."),
      h("p", { class: "hint", text: "Tap the mic to talk. Tap again to send." }),
      h("p", { class: "hint", text: "Automatic uses a saved voice key, preferring your chat AI. Voice uses that service's API quota." }),
      h("p", { class: "hint", text: 'Try “Mimo, go home”, “Mimo, open settings”, or “Mimo, show limits”.' })), panels);
}

function assistantSection(statuses: Record<CodingAssistant, HookStatus>): HTMLElement {
  const panels = h("div", { class: "assistant-panels" });
  const choices = CODING_PROVIDERS.map(({ id, name }) => ({ id, name }));
  const providers = choices.map(({ id }) => {
    const provider = id as CodingAssistant;
    const panel = h("div", { "data-assistant": provider },
      codingSection(statuses[provider], provider),
    );
    panels.append(panel);
    return { provider, panel };
  });
  const picker = new CompactDropdown("Coding connection", "settings-assistant", value => {
    settings.codingAssistant = value as CodingAssistant;
    refresh();
    void save();
  });
  picker.el.classList.add("settings-picker");
  let last: CodingAssistant | null = null;
  const refresh = () => {
    picker.update(choices, settings.codingAssistant, true);
    for (const { provider, panel } of providers) {
      const selected = provider === settings.codingAssistant;
      panel.hidden = !selected;
      panel.inert = !selected;
      if (last !== settings.codingAssistant)
        panel.querySelectorAll("input").forEach(input => { input.value = ""; });
    }
    last = settings.codingAssistant;
  };
  refreshControls.push(refresh);
  refresh();
  return h("div", { class: "assistant-settings" },
    h("section", { class: "preferences" },
      h("div", { class: "preference-row" },
        h("div", { class: "preference-copy" },
          h("label", { text: "Coding connection" }),
          h("span", { class: "hint", text: "Choose a tool to set up. Your other tools stay connected." })),
        picker.el)),
    panels);
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: {
    key: string;
    label: string;
    placeholder: string;
    secret: boolean;
  }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "integration_stripe",
    name: "Stripe",
    color: "#0570DE",
    fields: [
      {
        key: "stripe-api-key",
        label: "Secret key",
        placeholder: "sk_live_…",
        secret: true,
      },
    ],
  },
  {
    id: "integration_github",
    name: "GitHub",
    color: "#F4505E",
    fields: [
      {
        key: "github-token",
        label: "Token",
        placeholder: "ghp_…",
        secret: true,
      },
    ],
  },
  {
    id: "integration_vercel",
    name: "Vercel",
    color: "#7C5CFF",
    fields: [
      { key: "vercel-token", label: "Token", placeholder: "…", secret: true },
    ],
  },
  {
    id: "integration_n8n",
    name: "n8n",
    color: "#F29B38",
    fields: [
      {
        key: "n8n-url",
        label: "Instance URL",
        placeholder: "https://n8n.example.com",
        secret: false,
      },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ],
  },
  {
    id: "integration_resend",
    name: "Resend",
    color: "#22C55E",
    fields: [
      {
        key: "resend-api-key",
        label: "API key",
        placeholder: "re_…",
        secret: true,
      },
    ],
  },
  {
    id: "integration_notion",
    name: "Notion",
    color: "#8C8C8C",
    fields: [
      {
        key: "notion-api-key",
        label: "Integration token",
        placeholder: "ntn_…",
        secret: true,
      },
    ],
  },
  {
    id: "integration_calcom",
    name: "Cal.com",
    color: "#C9956A",
    fields: [
      {
        key: "calcom-api-key",
        label: "API key",
        placeholder: "cal_…",
        secret: true,
      },
    ],
  },
];

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", {
    style: "display:flex;flex-direction:column;gap:14px",
  });

  function updateNote() {
    note.textContent =
      "Choose your services. Keys are saved securely on this PC.";
  }

  for (const def of INTEGRATIONS) {
    const sw = toggle(
      def.name,
      () => settings.activeIntegrations.includes(def.id),
      (on) => {
        settings.activeIntegrations = on
          ? [...settings.activeIntegrations, def.id]
          : settings.activeIntegrations.filter((id) => id !== def.id);
        void save();
      },
    );

    const rows = h("div", {
      style:
        "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0",
    });
    for (const field of def.fields) {
      const credential = new CredentialField(field.key, def.name + " " + field.label,
        field.placeholder, field.secret, present[field.key] ?? false,
        saved => { present[field.key] = saved; });
      lifetime.own(() => credential.destroy());
      credentials.set(field.key, credential);
      rows.append(credential.el);
    }

    list.append(
      h(
        "div",
        { class: "integration-preference" },
        h(
          "div",
          { class: "preference-row" },
          h(
            "div",
            { class: "integration-name" },
            h("i", { class: "dot", style: `background:${def.color}` }),
            h("span", { text: def.name }),
          ),
          sw,
        ),
        h(
          "details",
          { class: "connection-settings" },
          h("summary", { text: "Connection settings" }),
          rows,
        ),
      ),
    );
  }

  updateNote();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Integrations" })),
    note,
    list,
  );
}

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range",
    min: "0",
    max: "0.2",
    step: "0.005",
    value: String(settings.soundVolume),
    "aria-label": "Notification sound volume",
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });
  const displays = [
    { id: "primary", name: "Main display" },
    { id: "cursor", name: "Display under the cursor" },
  ];
  const screen = new CompactDropdown(
    "Island display",
    "settings-display",
    (value) => {
      settings.screen = value as Settings["screen"];
      refreshDisplay();
      void save();
    },
  );
  screen.el.classList.add("settings-picker");
  const refreshDisplay = () => screen.update(displays, settings.screen, true);
  refreshDisplay();
  refreshControls.push(() => {
    volume.value = String(settings.soundVolume);
    volume.disabled = !settings.soundEnabled;
    refreshDisplay();
  });
  volume.disabled = !settings.soundEnabled;
  const workingState = h("span", { class: "working-mode-status", text: "Tabs stay clear" });
  const workingScene = h("div", { class: "working-mode-scene", role: "img",
    "aria-label": "Working mode enabled: Mimo's static 156 by 12 notch above a clear browser tab row." },
    h("div", { class: "working-mode-lip", "aria-hidden": "true" }),
    h("div", { class: "working-mode-browser", "aria-hidden": "true" },
      h("div", { class: "working-mode-tabs" },
        h("span", { class: "working-mode-tab", text: "Workspace" }), icon(ICONS.plus, 10),
        h("span", { class: "working-mode-window-controls" }, icon(ICONS.minus, 10), icon(ICONS.xmark, 10))),
      h("div", { class: "working-mode-address" }, icon(ICONS.chevronLeft, 10),
        h("span", { class: "working-mode-address-field", text: "Your work, in focus" })),
      h("div", { class: "working-mode-page" }, h("i"), h("i"), h("i"))));
  return h("div", { class: "general-settings" }, h(
    "section",
    { class: "preferences" },
    h("h2", { text: "At your side" }),
    preference(
      "Launch at startup",
      () => settings.autostart,
      (value) => {
        settings.autostart = value;
      },
      "Ready when you sign in.",
    ),
    preference(
      "Sound",
      () => settings.soundEnabled,
      (value) => {
        settings.soundEnabled = value;
      },
      "A soft sound when something needs you.",
    ),
    h(
      "div",
      { class: "preference-row quiet" },
      h("span", { text: "Notification volume" }),
      volume,
    ),
    h(
      "div",
      { class: "preference-row" },
      h("label", { text: "Island display" }),
      screen.el,
    ),
    preference(
      "Island clock",
      () => settings.clockEnabled,
      value => { settings.clockEnabled = value; },
      "Keep the time close by.",
    ),
    preference(
      "Grab Mimo",
      () => settings.grabEnabled,
      value => { settings.grabEnabled = value; },
      "Drag Mimo from the island to capture a window. Hold Ctrl when compact.",
    ),
  ), h("section", { class: "preferences working-mode-settings" },
    preference("Working mode", () => settings.workingModeEnabled,
      value => { settings.workingModeEnabled = value; },
      "Keep your browser tabs clear."),
    h("div", { class: "working-mode-preview" },
      workingScene,
      h("div", { class: "working-mode-readout" },
        h("span", { text: "Working mode" }), workingState))),
  );
}

function mediaSection(): HTMLElement {
  return h(
    "section",
    { class: "preferences" },
    h("h2", { text: "Your media" }),
    preference(
      "Media",
      () => settings.modules.media,
      (value) => {
        settings.modules.media = value;
      },
      "Your playback, close at hand.",
    ),
    h("p", {
      class: "hint",
      text: "Available controls depend on your player.",
    }),
  );
}

function hotkeysSection(): HTMLElement {
  const voiceValue=h("input",{class:"model-input",type:"text",value:settings.voiceShortcut,"aria-label":"Global voice shortcut"});
  const voiceStatus=h("p",{class:"hint",role:"status"});
  const voiceApply=h("button",{class:"btn secondary",type:"button",text:"Save shortcut",onclick:async()=>{
    voiceApply.disabled=true;
    try {
      const result=await Bridge.configureVoiceShortcut(voiceValue.value.trim());
      if(result?.error&&!result.error.startsWith("Connect an AI voice")) {voiceStatus.textContent=result.error;return;}
      settings.voiceShortcut=voiceValue.value.trim();await save();
      voiceStatus.textContent=result?.error ?? (settings.voiceShortcut ? "Shortcut ready. Press again to send; Esc closes voice." : "Voice shortcut off.");
    } catch(error) {voiceStatus.textContent=String(error).replace(/^Error:\s*/,"");} finally {voiceApply.disabled=false;}
  }});
  void Bridge.voiceShortcutStatus().then(result=>{voiceStatus.textContent=result?.error ?? "Available across your desktop when an AI voice key is connected.";});
  const value=h("input",{class:"model-input",type:"text",value:settings.workflowShortcut,"aria-label":"Global work shortcut"});
  const status=h("p",{class:"hint",role:"status"});
  const apply=h("button",{class:"btn secondary",type:"button",text:"Save shortcut",onclick:async()=>{
    apply.disabled=true;
    try {
      const result=await Bridge.configureWorkflowShortcut(value.value.trim());
      if(result?.error) {status.textContent=result.error;return;}
      settings.workflowShortcut=result?.shortcut ?? value.value.trim();await save();
      status.textContent=settings.workflowShortcut ? "Shortcut ready. Opens the next item that needs you." : "Global shortcut off.";
    } catch(error) {status.textContent=String(error);} finally {apply.disabled=false;}
  }});
  void Bridge.workflowShortcutStatus().then(result=>{
    if (result && settings.workflowShortcut && !result.registered) status.textContent=result.error ?? "Shortcut unavailable. Choose another combination.";
  });
  return h(
    "section",
    { class: "preferences" },
    h("h2",{text:"Global access"}),
    h("label",{text:"Open next work item"}),
    h("div",{class:"preference-row"},value,apply),status,
    h("label",{text:"Talk to Mimo"}),
    h("div",{class:"preference-row"},voiceValue,voiceApply),voiceStatus,
    h("p",{class:"hint",text:"Use Ctrl, Alt or Shift with a letter or Space. Clear it to turn it off."}),
    h("h2", { text: "In the island" }),
    h(
      "div",
      { class: "preference-row" },
      h("span", { text: "Minimize one step" }),
      h("kbd", { text: "Esc" }),
    ),
    h(
      "div",
      { class: "preference-row" },
      h("span", { text: "Move between controls" }),
      h("kbd", { text: "Tab / Shift + Tab" }),
    ),
    h(
      "div",
      { class: "preference-row" },
      h("span", { text: "Use the selected control" }),
      h("kbd", { text: "Enter / Space" }),
    ),
    h("p", {
      class: "hint",
      text: "Use these while the island is focused.",
    }),
  );
}

function aboutSection(): HTMLElement {
  return h(
    "section",
    { class: "about-panel" },
    h(
      "div",
      { class: "about-identity" },
      h("img", {
        class: "about-icon",
        src: appIcon,
        alt: "",
        width: 48,
        height: 48,
      }),
      h(
        "div",
        { class: "about-product" },
        h("h2", { text: "Mimo" }),
        h("p", { class: "hint about-version", text: `Version ${version || "0.1.1"}` }),
      ),
    ),
    h("p", {
      class: "about-description",
      text: "Music, work, and a little breathing room.",
    }),
    h("p", {
      class: "hint about-privacy",
      text: "No telemetry. Mimo only contacts your connected services.",
    }),
  );
}


async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = normalizeSettings(boot.settings);
    version = boot.version;
  }
  Sound.setEnabled(settings.soundEnabled);
  Sound.setVolume(settings.soundVolume);
  applyAppearance("dark");
  const emptyStatus = { installed: false, settingsPath: "", hookPath: "", hookReady: false };
  const statuses = Object.fromEntries(await Promise.all(CODING_PROVIDERS.map(async ({ id }) =>
    [id, await Bridge.hooksStatus(id) ?? { ...emptyStatus }]))) as Record<CodingAssistant, HookStatus>;
  const installed=await Bridge.installedCodingTools() ?? [];
  if (!settings.workflowSetupDone && !statuses[settings.codingAssistant].installed && installed.length)
    settings.codingAssistant=installed[0] as CodingAssistant;

  const keys = [
    "anthropic-api-key",
    "openai-api-key",
    "gemini-api-key",
    "openrouter-api-key",
    "xai-api-key",
    "groq-api-key",
    "stripe-api-key",
    "github-token",
    "vercel-token",
    "n8n-url",
    "n8n-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  await Promise.all(keys.map(async key => { present[key] = (await Bridge.secretPresent(key)) ?? false; }));

  if (!lifetime.active) return;

  clear(root);
  const navigation = h("nav", {
    class: "settings-sidebar",
    "aria-label": "Settings sections",
  });
  const content = h("main", { class: "settings-content" });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) root.querySelectorAll<HTMLInputElement>(".credential-field input").forEach(input => { input.value = ""; });
  }, { signal: lifetime.signal });
  const pages = [
    {
      id: "general",
      label: "General",
      glyph: appearance,
      sections: [generalSection()],
    },
    {
      id: "media",
      label: "Media",
      glyph: musicMode,
      sections: [mediaSection()],
    },
    {
      id: "chat",
      label: "Chat",
      glyph: ICONS.bubble,
      sections: [chatSection(present)],
    },
    {
      id: "modules",
      label: "Modules",
      glyph: ICONS.stack,
      sections: [modulesSection(), assistantSection(statuses)],
    },
    {
      id: "integrations",
      label: "Integrations",
      glyph: ICONS.integrations,
      sections: [integrationsSection(present)],
    },
    {
      id: "usage",
      label: "Usage",
      glyph: ICONS.usage,
      sections: [h("section", { class: "preferences" },
        preference("Limits & remaining capacity", () => settings.usageEnabled, value => { settings.usageEnabled = value; },
          "Show capacity beside Settings in expanded views and open your limits. Reads pause when off."),
        h("p", { class: "hint", text: "Uses your existing sign-ins. No key needed." }))],
    },
    {
      id: "hotkeys",
      label: "Hotkeys",
      glyph: ICONS.keyboard,
      sections: [hotkeysSection()],
    },
    {
      id: "about",
      label: "About",
      glyph: ICONS.info,
      sections: [aboutSection()],
    },
  ];
  for (const page of pages) {
    for (const section of page.sections) {
      if (section.tagName === "SECTION") section.classList.add("settings-panel");
      section.querySelectorAll("section").forEach(panel => panel.classList.add("settings-panel"));
    }
  }
  const panels = new Map<string, HTMLElement>();
  const buttons = new Map<string, HTMLButtonElement>();
  function select(id: string) {
    for (const [key, panel] of panels) {
      if (key !== id) panel.querySelectorAll("input[type=password]").forEach(input => { (input as HTMLInputElement).value = ""; });
      panel.hidden = key !== id;
      panel.inert = key !== id;
    }
    for (const [key, button] of buttons) {
      button.classList.toggle("selected", key === id);
      if (key === id) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    content.scrollTop = 0;
  }
  for (const page of pages) {
    const panel = h(
      "div",
      {
        class: "settings-page",
        id: `settings-${page.id}`,
        "aria-labelledby": `heading-${page.id}`,
      },
      h("h1", { id: `heading-${page.id}`, text: page.label }),
      ...page.sections,
    );
    const button = h(
      "button",
      {
        type: "button",
        class: "settings-nav-item",
        "aria-controls": panel.id,
        onclick: () => select(page.id),
      },
      typeof page.glyph === "string"
        ? icon(page.glyph, 20)
        : mimoIcon(page.glyph, 20),
      h("span", { text: page.label }),
    );
    panels.set(page.id, panel);
    buttons.set(page.id, button);
    navigation.append(button);
    content.append(panel);
  }
  root.append(
    h(
      "header",
      { class: "settings-titlebar" },
      h("img", {
        class: "app-mark",
        src: appIcon,
        alt: "",
        width: 28,
        height: 28,
      }),
      h("span", { class: "settings-brand", text: "Settings" }),
      h("span", { class: "settings-titlebar-note", text: "Mimo" }),
    ),
    h("div", { class: "settings-shell" }, navigation, content),
  );
  select("general");
  void onEvent<string>("settings-page", page=>{
    const target = page === "connections" ? "modules" : page;
    select(panels.has(target) ? target : "general");
  }).then(stop=>lifetime.own(stop));

  void onEvent<Settings>("settings-changed", (s) => {
    settings = normalizeSettings(s);
    Sound.setEnabled(settings.soundEnabled);
    Sound.setVolume(settings.soundVolume);
    refreshControls.forEach((refresh) => refresh());
  }).then(stop => lifetime.own(stop));
  void onEvent<IslandVisibility>("visibility-changed", (visibility) => {
    settings.lastVisibility = visibility;
  }).then(stop => lifetime.own(stop));
  void onEvent<{ key: string; present: boolean }>("credentials-changed", ({ key, present }) => {
    credentials.get(key)?.update(present);
  }).then(stop => lifetime.own(stop));
  void onEvent<null>("settings-hidden", () => {
    root.querySelectorAll<HTMLInputElement>(".credential-field input").forEach(input => { input.value = ""; });
  }).then(stop => lifetime.own(stop));
  lifetime.own(() => credentials.clear());
}

void main();
