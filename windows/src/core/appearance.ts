// SPDX-License-Identifier: MIT
/** Persisted island appearance; the Settings window always uses Dark tokens. */
export type Appearance = "dark";
export type Platform = "windows" | "macos" | "linux";

export function normalizeAppearance(_value: unknown): Appearance {
  return "dark";
}

/** The OS this webview runs on (WebView2, WKWebView and WebKitGTK all say so in the user agent). */
export function hostPlatform(agent = navigator.userAgent): Platform {
  return /Mac OS X|Macintosh/.test(agent) ? "macos" : /Linux|X11/.test(agent) && !/Android/.test(agent) ? "linux" : "windows";
}

/** Also sets `<html data-os>`: design/tokens.css gives each OS its own type and corner shapes. */
export function applyAppearance(value: Appearance): void {
  document.documentElement.dataset.appearance = normalizeAppearance(value);
  document.documentElement.dataset.os = hostPlatform();
}
