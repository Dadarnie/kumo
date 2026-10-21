// SPDX-License-Identifier: MIT
// Boot persistent preferences and attach only the enabled module subscriptions.

import "./style.css";
import { Bridge, IS_TAURI, onEvent, type CursorSample, type IslandPositionInfo } from "./core/bridge";
import { startMediaStore, startAudioStore } from "./core/media-bridge";
import { Sound } from "./core/sound";
import { State, normalizeSettings, type Settings } from "./core/state";
import { CODING_PROVIDERS, codingInstalled } from "./core/coding";
import { chatDefinition } from "./core/chat-providers";
import { ModuleSubscription } from "./core/module-lifecycle";
import { Lifetime } from "./core/lifetime";
import { mediaStore } from "./core/media-store";
import { Island } from "./island/island";
import { expireApprovals, registerHookHandlers, resetProviderSession } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { registerRaphaelHandlers, syncRaphaelSettings, toggleRaphaelMute } from "./island/raphael";
import { Activity } from "./core/activity";
import type { ClaudeUsage } from "./core/codex-usage";

async function main() {
  document.documentElement.dataset.native = String(IS_TAURI);
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);
  const lifetime = new Lifetime();
  lifetime.own(() => island.destroy());
  const subscriptions = {
    media: new ModuleSubscription(() => startMediaStore()),
    vscode: new ModuleSubscription(() => registerHookHandlers(island)),
    developerIntegrations: new ModuleSubscription(() => registerIntegrationHandlers(island)),
  };
  const applyPreferences = () => {
    State.loadIntegrationTasks();
    island.applySettings();
    syncRaphaelSettings(island);
    for (const [id, subscription] of Object.entries(subscriptions)) {
      void subscription
        .setEnabled(State.settings.modules[id as keyof typeof subscriptions])
        .catch((error) => console.error(`[mimo] ${id} subscription failed`, error));
    }
    void refreshConfigured();
  };
  const stop = () => {
    if (!lifetime.active) return;
    Activity.flush();
    lifetime.destroy();
    for (const subscription of Object.values(subscriptions)) void subscription.destroy();
    mediaStore.dispose();
    Sound.destroy();
  };
  window.addEventListener("pagehide", stop, { once: true, signal: lifetime.signal });
  import.meta.hot?.dispose(stop);

  lifetime.own(await startAudioStore());
  lifetime.own(Activity.subscribe(() => State.notify()));
  lifetime.own(await onEvent<ClaudeUsage>("agent-usage", snapshot => {
    if (State.settings.usageEnabled) Activity.observeUsage("claude", snapshot);
  }));
  if (!lifetime.active) return;

  // Subscribe before boot so a newer OS observation wins over the boot snapshot.
  let powerObserved = false;
  let positionObserved = false;
  lifetime.own(await onEvent<IslandPositionInfo>("island-position", position => {
    positionObserved = true;
    island.setPosition(position);
  }));
  lifetime.own(await onEvent<unknown>("power-status", snapshot => {
    powerObserved = true;
    State.observePower(snapshot);
    expireApprovals(island);
  }));
  if (!lifetime.active) return;
  const boot = await Bridge.boot();
  if (!lifetime.active) return;
  if (boot) {
    State.settings = normalizeSettings(boot.settings);
    if (!powerObserved) State.observePower(boot.power);
    if (!positionObserved && boot.position) island.setPosition(boot.position);
  }
  applyPreferences();
  lifetime.own(await onEvent<null>("workflow-shortcut",()=>island.openNextWork()));
  lifetime.own(await registerRaphaelHandlers(island));
  // With Raphael on, the voice shortcut turns its microphone on and off.
  lifetime.own(await onEvent<null>("voice-shortcut",()=>{if(!toggleRaphaelMute())void island.toggleDesktopVoice();}));
  lifetime.own(await onEvent<null>("voice-cancel",()=>island.closeDesktopVoice()));
  let grabObserved = false;
  lifetime.own(await onEvent<boolean>("grab-detached",value=>{
    grabObserved = true;
    island.setGrabDetached(value);
  }));
  lifetime.own(await onEvent<boolean>("grab-hover",value=>island.setGrabReturnHover(value)));
  lifetime.own(await onEvent<{captured:boolean}>("grab-returning",value=>island.prepareGrabReturn(value.captured)));
  lifetime.own(await onEvent<null>("grab-shutter",()=>Sound.play("attach")));
  lifetime.own(await onEvent<null>("grab-return",()=>{
    island.setGrabDetached(false);
    Sound.play("close");
  }));
  lifetime.own(await onEvent<boolean>("grab-control",value=>island.setGrabModifier(value)));
  lifetime.own(await onEvent<string[]>("grab-file-drop",paths=>island.receiveGrabDrop(paths)));
  lifetime.own(await onEvent<null>("grab-open",()=>{
    island.setGrabDetached(false);
    island.open("grab");
  }));
  void Bridge.grabRead().then(value=>{
    if (lifetime.active && !grabObserved && value) island.setGrabDetached(value.detached);
  }).catch(()=>{});
  lifetime.own(await onEvent<null>("workflow-reconcile",()=>expireApprovals(island)));


  lifetime.own(await onEvent<CursorSample>("cursor", sample => island.onCursor(sample.x, sample.y, sample)));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    if (on) island.closeDesktopVoice();
    void Bridge.setPaused(on);
  };

  lifetime.own(await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        void Bridge.openSettingsWindow();
        break;
      case "open":
        setPaused(false);
        island.open(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.visibility.peek();
        else island.visibility.island();
        break;
    }
  }));

  lifetime.own(await onEvent<null>("screen-changed", () => void Bridge.reposition()));

  // The settings window writes preferences; apply them here without a restart.
  lifetime.own(await onEvent<Settings>("settings-changed", (s) => {
    s = normalizeSettings(s);
    for (const { id } of CODING_PROVIDERS)
      if (codingInstalled(State.settings, id) && !codingInstalled(s, id)) resetProviderSession(island, id);
    if (State.settings.chatProvider !== s.chatProvider
        || JSON.stringify(State.settings.chatModels) !== JSON.stringify(s.chatModels)) {
      State.clearChat(true);
    }
    State.settings = normalizeSettings(s);
    applyPreferences();
  }));
  lifetime.own(await onEvent<{ key: string; present: boolean }>("credentials-changed", ({ key }) => {
    State.chatConnectionsVersion++;
    const activeKey = chatDefinition(State.settings.chatProvider).key;
    if (key === activeKey) {
      State.clearChat();
      State.notify();
    }
    void refreshConfigured();
    State.notify();
  }));

  if (!lifetime.active) return;
  island.launch();

  // Browser previews resume audio on the first explicit interaction.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true, signal: lifetime.signal });
  }
}

void main();
