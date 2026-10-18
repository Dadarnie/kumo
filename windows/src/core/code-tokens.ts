// SPDX-License-Identifier: MIT
/** Small, bounded lexical coloring for hook previews. All output stays plain text. */
export interface CodeToken { text: string; kind?: string }

const CODE = /(\/\/.*$|\/\*.*?\*\/|#[^\n]*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:async|await|break|case|class|const|continue|def|else|enum|export|extends|false|fn|for|from|function|if|impl|import|in|interface|let|match|mod|new|null|pub|return|self|static|struct|throw|true|try|type|use|var|while|yield)\b)|(\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)\b)|(\b[A-Za-z_$][\w$]*(?=\s*\())|(\b[A-Z][\w]*\b)|([=+*<>!&|?%-]+)/g;
const TERMINAL = /(\b(?:PASS|passed|success|succeeded|OK)\b)|(\b(?:FAIL|failed|error|ERR)\b)|(\b\d+(?:\.\d+)?\b)|(^\$)/gi;
const CODE_KINDS = ["comment", "string", "keyword", "number", "function", "type", "operator"];
const TERMINAL_KINDS = ["success", "error", "number", "comment"];

export function codeTokens(text: string, terminal = false): CodeToken[] {
  const result: CodeToken[] = [];
  const pattern = terminal ? TERMINAL : CODE;
  const kinds = terminal ? TERMINAL_KINDS : CODE_KINDS;
  pattern.lastIndex = 0;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > end) result.push({ text: text.slice(end, match.index) });
    const group = match.slice(1).findIndex(value => value !== undefined);
    result.push({ text: match[0], kind: kinds[group] });
    end = match.index! + match[0].length;
  }
  if (end < text.length) result.push({ text: text.slice(end) });
  return result;
}
