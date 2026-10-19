// SPDX-License-Identifier: MIT
/** Usage stays with its agent session; a quota percentage is not a token count. */
export interface CodingUsage {
  sessionTokens?: number;
  promptBaseline?: number;
  promptTokens?: number;
  responseTokens?: number;
}

export function codingUsage(event: { hook_event_name?: string; mimo_usage?: unknown }, previous?: CodingUsage): CodingUsage | undefined {
  if (event.hook_event_name === 'SessionStart') return undefined;
  const next: CodingUsage = event.hook_event_name === 'UserPromptSubmit'
    ? previous?.sessionTokens === undefined ? {} : {sessionTokens:previous.sessionTokens,promptBaseline:previous.sessionTokens}
    : {...previous};
  const reported = event.mimo_usage as {totalTokens?: unknown; cumulative?: unknown} | undefined;
  const count = reported?.totalTokens;
  if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000
    && typeof reported?.cumulative === 'boolean') {
    if (reported.cumulative) {
      next.sessionTokens = Math.max(next.sessionTokens ?? 0, count);
      if (next.promptBaseline !== undefined) next.promptTokens = next.sessionTokens - next.promptBaseline;
    } else next.responseTokens = count;
  }
  return Object.keys(next).length ? next : undefined;
}
