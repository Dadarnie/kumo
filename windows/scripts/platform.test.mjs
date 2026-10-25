// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./ts-test-loader.mjs";
const { hostPlatform } = await import(await loadSource("../src/core/appearance.ts"));

test("each webview's user agent maps to its OS look", () => {
  assert.equal(hostPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Edg/130"), "windows");
  assert.equal(hostPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"), "macos");
  assert.equal(hostPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"), "linux");
});
