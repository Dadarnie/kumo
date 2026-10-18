// SPDX-License-Identifier: MIT
import type { CodingProvider } from "./coding";

/** Native window identity used only to return to an observed coding session. */
export interface ReturnTarget { pid: number; createdAt: string; hwnd: string }
export const sessionKey = (provider: CodingProvider, sessionId: string) => `session_${provider}_${encodeURIComponent(sessionId)}`;
