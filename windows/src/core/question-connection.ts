// SPDX-License-Identifier: MIT
import type { CodingProvider } from "./coding";

/** A reviewable local MCP connection. This never writes an agent's settings. */
export function questionConnection(provider: CodingProvider, hookPath: string): string {
  const command = hookPath.replaceAll("\\", "/");
  const args = ["--mcp", "--provider", provider];
  if (provider === "codex") return `[mcp_servers.kumo]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 120`;
  return JSON.stringify({command, args}, null, 2);
}
