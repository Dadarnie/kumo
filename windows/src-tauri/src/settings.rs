// SPDX-License-Identifier: MIT
// Preferences, stored as plain JSON in settings.json under windows::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub notices: NoticePreferences,
    #[serde(default)]
    pub snooze_until: u64,
    #[serde(default = "default_workflow_shortcut")]
    pub workflow_shortcut: String,
    #[serde(default)]
    pub workflow_setup_done: bool,
    #[serde(default)]
    pub appearance: Appearance,
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    /// Optional horizontal fraction on that display's top edge.
    #[serde(default)]
    pub island_anchor: Option<f64>,
    #[serde(default)]
    pub desktop_companion: Option<DesktopCompanionPosition>,
    pub autostart: bool,
    pub hooks_installed: bool,
    #[serde(default)]
    pub coding_assistant: CodingAssistant,
    #[serde(default)]
    pub coding_hooks_installed: BTreeMap<CodingAssistant, bool>,
    #[serde(default)]
    pub chat_provider: ChatProvider,
    #[serde(default = "default_chat_models")]
    pub chat_models: BTreeMap<ChatProvider, String>,
    /// Turns the assistant's microphone on and off.
    #[serde(default = "default_voice_shortcut")]
    pub voice_shortcut: String,
    #[serde(default)]
    pub codex_hooks_installed: bool,
    #[serde(default = "default_codex_model")]
    pub codex_model: String,
    #[serde(default = "enabled")]
    pub usage_enabled: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub auto_collapse_enabled: bool,
    #[serde(default = "enabled")]
    pub remember_compact_state: bool,
    // Legacy key is accepted for older settings, but no longer enables a mode.
    #[serde(default)]
    pub peek_enabled: bool,
    #[serde(default = "enabled")]
    pub working_mode_enabled: bool,
    #[serde(default = "enabled")]
    pub clock_enabled: bool,
    #[serde(default = "enabled")]
    pub grab_enabled: bool,
    #[serde(default)]
    pub hover_behavior_version: u8,
    #[serde(default)]
    pub last_visibility: IslandVisibility,
    #[serde(default)]
    pub modules: ModulePreferences,
    /// Run Kumo's voice assistant (the `assistant/` folder). Older settings used raphael* keys.
    #[serde(default, alias = "raphaelEnabled")]
    pub assistant_enabled: bool,
    /// Off: the assistant waits for "hey kumo".
    #[serde(default = "enabled", alias = "raphaelAlwaysListen")]
    pub assistant_always_listen: bool,
    /// Ollama model id; empty = the assistant's own default.
    #[serde(default, alias = "raphaelModel")]
    pub assistant_model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopCompanionPosition {
    pub monitor: String,
    pub x: f64,
    pub y: f64,
}

impl DesktopCompanionPosition {
    pub fn normalize(self) -> Option<Self> {
        if self.monitor.is_empty()
            || self.monitor.len() > 256
            || !self.x.is_finite()
            || !self.y.is_finite()
        {
            return None;
        }
        Some(Self {
            monitor: self.monitor,
            x: self.x.clamp(0.0, 1.0),
            y: self.y.clamp(0.0, 1.0),
        })
    }
}

fn enabled() -> bool {
    true
}
fn default_workflow_shortcut() -> String {
    "Ctrl+Alt+M".into()
}
fn default_voice_shortcut() -> String {
    "Ctrl+Alt+V".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoticePreferences {
    pub coding: bool,
    pub other: bool,
}
impl Default for NoticePreferences {
    fn default() -> Self {
        Self {
            coding: true,
            other: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodingAssistant {
    #[default]
    Claude,
    Codex,
    Cursor,
    Gemini,
    Antigravity,
    Muse,
    Opencode,
    Copilot,
    Hermes,
}

impl CodingAssistant {
    pub const ALL: [Self; 9] = [
        Self::Claude,
        Self::Codex,
        Self::Cursor,
        Self::Gemini,
        Self::Antigravity,
        Self::Muse,
        Self::Opencode,
        Self::Copilot,
        Self::Hermes,
    ];
    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Gemini => "gemini",
            Self::Antigravity => "antigravity",
            Self::Muse => "muse",
            Self::Opencode => "opencode",
            Self::Copilot => "copilot",
            Self::Hermes => "hermes",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
            Self::Gemini => "Gemini CLI",
            Self::Antigravity => "Antigravity",
            Self::Muse => "Muse Code",
            Self::Opencode => "OpenCode",
            Self::Copilot => "Copilot CLI",
            Self::Hermes => "Hermes Agent",
        }
    }
    pub fn approvals(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatProvider {
    #[default]
    Anthropic,
    Openai,
    Gemini,
    Openrouter,
    Xai,
    Groq,
    Ollama,
}
impl ChatProvider {
    pub const ALL: [Self; 7] = [
        Self::Anthropic,
        Self::Openai,
        Self::Gemini,
        Self::Openrouter,
        Self::Xai,
        Self::Groq,
        Self::Ollama,
    ];
    pub fn key(self) -> Option<&'static str> {
        match self {
            Self::Anthropic => Some("anthropic-api-key"),
            Self::Openai => Some("openai-api-key"),
            Self::Gemini => Some("gemini-api-key"),
            Self::Openrouter => Some("openrouter-api-key"),
            Self::Xai => Some("xai-api-key"),
            Self::Groq => Some("groq-api-key"),
            Self::Ollama => None,
        }
    }
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => crate::claude::DEFAULT_MODEL,
            Self::Openai => "gpt-6.1-sol",
            Self::Gemini => "gemini-2.5-flash-lite",
            Self::Openrouter => "openrouter/free",
            Self::Xai => "grok-4.7",
            Self::Groq => "openai/gpt-oss-120b",
            Self::Ollama => "hermes3",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude",
            Self::Openai => "OpenAI",
            Self::Gemini => "Gemini",
            Self::Openrouter => "OpenRouter",
            Self::Xai => "Grok",
            Self::Groq => "Groq",
            Self::Ollama => "Ollama",
        }
    }
}
fn default_chat_models() -> BTreeMap<ChatProvider, String> {
    ChatProvider::ALL
        .into_iter()
        .map(|p| (p, p.default_model().into()))
        .collect()
}

fn default_codex_model() -> String {
    "gpt-6.1-sol".into()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    #[serde(other)]
    Dark,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IslandVisibility {
    #[default]
    Expanded,
    Island,
    Peek,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModulePreferences {
    pub media: bool,
    pub vscode: bool,
    pub developer_integrations: bool,
}
impl Default for ModulePreferences {
    fn default() -> Self {
        Self {
            media: true,
            vscode: true,
            developer_integrations: true,
        }
    }
}

impl Settings {
    pub fn chat_model(&self) -> &str {
        self.chat_models
            .get(&self.chat_provider)
            .map(String::as_str)
            .unwrap_or_else(|| self.chat_provider.default_model())
    }
    pub fn chat_changed(&self, next: &Self) -> bool {
        self.chat_provider != next.chat_provider || self.chat_models != next.chat_models
    }
    pub fn upgrade_hover_behavior(&mut self) {
        // Keep the serialized key compatible, but use one automatic delay.
        self.auto_close_interval = 1.0;
        self.hover_behavior_version = 1;
        self.auto_collapse_enabled = true;
        self.remember_compact_state = true;
    }
    pub fn startup_visibility(&self) -> IslandVisibility {
        if !self.remember_compact_state {
            return IslandVisibility::Expanded;
        }
        match self.last_visibility {
            IslandVisibility::Peek => IslandVisibility::Island,
            visibility => visibility,
        }
    }
    pub fn integration_enabled(&self, id: &str) -> bool {
        self.modules.developer_integrations
            && self.active_integrations.iter().any(|active| active == id)
    }
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            notices: NoticePreferences::default(),
            snooze_until: 0,
            workflow_shortcut: default_workflow_shortcut(),
            voice_shortcut: default_voice_shortcut(),
            workflow_setup_done: false,
            appearance: Appearance::Dark,
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 1.0,
            absence_interval: 180.0,
            active_integrations: vec![],
            screen: "primary".into(),
            island_anchor: None,
            desktop_companion: None,
            autostart: false,
            hooks_installed: false,
            coding_assistant: CodingAssistant::Claude,
            coding_hooks_installed: BTreeMap::new(),
            chat_provider: ChatProvider::Anthropic,
            chat_models: default_chat_models(),
            codex_hooks_installed: false,
            codex_model: default_codex_model(),
            usage_enabled: true,
            model: default_model(),
            auto_collapse_enabled: true,
            remember_compact_state: true,
            last_visibility: IslandVisibility::Island,
            peek_enabled: false,
            working_mode_enabled: true,
            clock_enabled: true,
            grab_enabled: true,
            hover_behavior_version: 1,
            modules: ModulePreferences::default(),
            assistant_enabled: false,
            assistant_always_listen: true,
            assistant_model: String::new(),
        }
    }
}

pub use crate::windows::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::windows::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path())
        .or_else(|_| std::fs::read(crate::migration::legacy_config_dir().join("settings.json")))
    {
        Ok(bytes) => {
            let mut settings = from_bytes(&bytes).unwrap_or_default();
            settings.upgrade_hover_behavior();
            settings
        }
        Err(_) => Settings::default(),
    }
}

fn from_bytes(bytes: &[u8]) -> Result<Settings, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    let mut settings: Settings = serde_json::from_value(value.clone())?;
    settings.island_anchor = settings
        .island_anchor
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0.0, 1.0));
    settings.desktop_companion = None;
    settings.peek_enabled = false;
    // Migration happens only for files predating independent chat settings.
    if value.get("chatProvider").is_none() {
        settings.chat_provider = if settings.coding_assistant == CodingAssistant::Codex {
            ChatProvider::Openai
        } else {
            ChatProvider::Anthropic
        };
    }
    if value.get("chatModels").is_none() {
        settings
            .chat_models
            .insert(ChatProvider::Anthropic, settings.model.clone());
        settings
            .chat_models
            .insert(ChatProvider::Openai, settings.codex_model.clone());
    }
    for p in ChatProvider::ALL {
        settings
            .chat_models
            .entry(p)
            .or_insert_with(|| p.default_model().into());
    }
    Ok(settings)
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let mut settings = settings.clone();
    settings.island_anchor = settings
        .island_anchor
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0.0, 1.0));
    settings.desktop_companion = None;
    settings.peek_enabled = false;
    settings.upgrade_hover_behavior();
    let dir = config_dir();
    crate::windows::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(&settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peek_position_is_optional_for_old_settings_and_remains_horizontal() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("islandAnchor");
        assert_eq!(
            from_bytes(&serde_json::to_vec(&old).unwrap())
                .unwrap()
                .island_anchor,
            None
        );
        for (value, expected) in [(-2.0, 0.0), (0.23, 0.23), (2.0, 1.0)] {
            old["islandAnchor"] = serde_json::json!(value);
            let loaded = from_bytes(&serde_json::to_vec(&old).unwrap()).unwrap();
            assert_eq!(loaded.island_anchor, Some(expected));
            let round_trip = from_bytes(&serde_json::to_vec(&loaded).unwrap()).unwrap();
            assert_eq!(round_trip.island_anchor, Some(expected));
            assert!(serde_json::to_value(round_trip)
                .unwrap()
                .get("islandAnchorY")
                .is_none());
        }
    }

    #[test]
    fn legacy_chat_migrates_once_and_editor_switches_preserve_chat() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("chatProvider");
        old.as_object_mut().unwrap().remove("chatModels");
        old["codingAssistant"] = serde_json::json!("codex");
        old["codexModel"] = serde_json::json!("custom-model");
        let settings = from_bytes(&serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(settings.chat_provider, ChatProvider::Openai);
        assert_eq!(settings.chat_model(), "custom-model");
        let mut next = settings.clone();
        next.coding_assistant = CodingAssistant::Gemini;
        assert!(!settings.chat_changed(&next));
        let restored = from_bytes(&serde_json::to_vec(&next).unwrap()).unwrap();
        assert_eq!(restored.chat_provider, ChatProvider::Openai);
        next.chat_provider = ChatProvider::Gemini;
        assert!(settings.chat_changed(&next));
    }

    #[test]
    fn island_clock_defaults_on_and_preserves_off() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("clockEnabled");
        assert!(
            from_bytes(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .clock_enabled
        );
        value["clockEnabled"] = serde_json::json!(false);
        let saved = from_bytes(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(!saved.clock_enabled);
        assert!(
            !from_bytes(&serde_json::to_vec(&saved).unwrap())
                .unwrap()
                .clock_enabled
        );
    }

    #[test]
    fn hover_preferences_default_to_one_second_and_optional_peek() {
        let settings = Settings::default();
        assert_eq!(settings.auto_close_interval, 1.0);
        assert!(settings.auto_collapse_enabled);
        assert!(!settings.peek_enabled);
        assert!(settings.working_mode_enabled);
    }

    #[test]
    fn grab_defaults_on_and_preserves_disabled_preference() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("grabEnabled");
        assert!(
            from_bytes(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .grab_enabled
        );
        value["grabEnabled"] = serde_json::json!(false);
        let saved = from_bytes(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(!saved.grab_enabled);
        assert!(
            !from_bytes(&serde_json::to_vec(&saved).unwrap())
                .unwrap()
                .grab_enabled
        );
    }

    #[test]
    fn working_mode_defaults_on_and_removes_legacy_sleeping_desktop_state() {
        let mut legacy = serde_json::to_value(Settings::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("workingModeEnabled");
        legacy["peekEnabled"] = serde_json::json!(true);
        legacy["desktopCompanion"] = serde_json::json!({"monitor":"old","x":0.2,"y":0.5});
        legacy["lastVisibility"] = serde_json::json!("peek");
        let mut migrated = from_bytes(&serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(migrated.working_mode_enabled);
        assert!(!migrated.peek_enabled);
        assert!(migrated.desktop_companion.is_none());
        assert_eq!(migrated.startup_visibility(), IslandVisibility::Island);
        migrated.working_mode_enabled = false;
        assert!(
            !from_bytes(&serde_json::to_vec(&migrated).unwrap())
                .unwrap()
                .working_mode_enabled
        );
    }

    #[test]
    fn settling_delay_is_automatic_for_legacy_and_current_preferences() {
        let mut settings = Settings::default();
        settings.hover_behavior_version = 0;
        settings.auto_close_interval = 15.0;
        settings.auto_collapse_enabled = false;
        settings.upgrade_hover_behavior();
        assert_eq!(settings.auto_close_interval, 1.0);
        assert!(settings.auto_collapse_enabled);
        settings.auto_close_interval = 15.0;
        settings.upgrade_hover_behavior();
        assert_eq!(settings.auto_close_interval, 1.0);
        settings.hover_behavior_version = 0;
        settings.auto_close_interval = 7.0;
        settings.upgrade_hover_behavior();
        assert_eq!(settings.auto_close_interval, 1.0);
    }

    #[test]
    fn older_preferences_keep_modules_and_use_safe_behavior_defaults() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        for key in [
            "appearance",
            "autoCollapseEnabled",
            "rememberCompactState",
            "lastVisibility",
            "modules",
        ] {
            old.as_object_mut().unwrap().remove(key);
        }
        let settings: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(settings.appearance, Appearance::Dark);
        assert!(!settings.auto_collapse_enabled);
        assert!(settings.remember_compact_state);
        assert_eq!(settings.modules, ModulePreferences::default());
        assert_eq!(settings.startup_visibility(), IslandVisibility::Expanded);
    }

    #[test]
    fn appearance_modes_round_trip_without_resetting_preferences() {
        for appearance in [Appearance::Dark] {
            let mut settings = Settings::default();
            settings.appearance = appearance;
            settings.sound_enabled = false;
            let restored: Settings =
                serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
            assert_eq!(restored.appearance, appearance);
            assert!(!restored.sound_enabled);
        }
    }

    #[test]
    fn retired_appearance_falls_back_to_dark_without_resetting_preferences() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["appearance"] = serde_json::json!("glass");
        value["soundEnabled"] = serde_json::json!(false);
        let settings: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(settings.appearance, Appearance::Dark);
        assert!(!settings.sound_enabled);
    }

    #[test]
    fn preferences_round_trip_and_parent_module_gates_individual_integrations() {
        let mut settings = Settings::default();
        settings.auto_collapse_enabled = true;
        settings.modules.vscode = false;
        settings.modules.media = false;
        settings.modules.developer_integrations = false;
        settings.active_integrations =
            vec!["integration_github".into(), "integration_stripe".into()];
        settings.last_visibility = IslandVisibility::Peek;
        let restored: Settings =
            serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
        assert_eq!(restored.modules, settings.modules);
        assert!(restored.auto_collapse_enabled);
        assert!(!restored.integration_enabled("integration_github"));
        assert_eq!(restored.startup_visibility(), IslandVisibility::Island);
        settings.modules.developer_integrations = true;
        assert!(settings.integration_enabled("integration_github"));
        assert!(settings.integration_enabled("integration_stripe"));
        assert!(!settings.integration_enabled("integration_n8n"));
        settings.remember_compact_state = false;
        assert_eq!(settings.startup_visibility(), IslandVisibility::Expanded);
    }

    #[test]
    fn partial_module_preferences_preserve_unspecified_modules() {
        let modules: ModulePreferences = serde_json::from_str(r#"{"vscode":false}"#).unwrap();
        assert!(!modules.vscode);
        assert!(modules.media);
        assert!(modules.developer_integrations);
    }

    #[test]
    fn older_preferences_discard_retired_features_and_default_notifications() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        for key in ["notices", "snoozeUntil"] {
            value.as_object_mut().unwrap().remove(key);
        }
        value["watchedProject"] = serde_json::json!({"repository":"team/shop"});
        value["downloadsEnabled"] = serde_json::json!(true);
        let settings: Settings = serde_json::from_value(value).unwrap();
        let saved = serde_json::to_value(&settings).unwrap();
        assert!(saved.get("watchedProject").is_none());
        assert!(saved.get("downloadsEnabled").is_none());
        assert_eq!(settings.notices, NoticePreferences::default());
        assert_eq!(settings.snooze_until, 0);
        let partial: NoticePreferences = serde_json::from_str(r#"{"coding":false}"#).unwrap();
        assert!(!partial.coding);
        assert!(partial.other);
    }
}

#[cfg(test)]
mod renamed_keys {
    #[test]
    fn old_raphael_keys_still_load() {
        let mut v = serde_json::to_value(super::Settings::default()).unwrap();
        let map = v.as_object_mut().unwrap();
        for key in [
            "assistantEnabled",
            "assistantAlwaysListen",
            "assistantModel",
        ] {
            map.remove(key);
        }
        map.insert("raphaelEnabled".into(), true.into());
        map.insert("raphaelAlwaysListen".into(), false.into());
        map.insert("raphaelModel".into(), "m".into());
        map.insert("raphaelDir".into(), "x".into());
        let s = super::from_bytes(&serde_json::to_vec(&v).unwrap()).expect("parses");
        assert!(s.assistant_enabled && !s.assistant_always_listen && s.assistant_model == "m");
    }
}
