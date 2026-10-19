// SPDX-License-Identifier: MIT
import type { ApprovalInfo } from './state';
import type { CodingProvider } from './coding';

// A remembered approval belongs to one live agent session and one exact input.
// Nothing is written to provider policy files or shared between workspaces.
const allowed = new Map<string, {provider: CodingProvider; session: string}>();
export function permissionKey(request: ApprovalInfo): string | undefined {
  if (request.questions || !request.provider || !request.sessionId || !request.cwd || !request.inputKey) return;
  return JSON.stringify([request.provider, request.sessionId, request.cwd, request.tool, request.inputKey]);
}
export function rememberPermission(request: ApprovalInfo): void {
  const key = permissionKey(request);
  if (!key || !request.provider) return;
  allowed.set(key, {provider: request.provider, session: request.sessionId});
  if (allowed.size > 128) allowed.delete(allowed.keys().next().value!);
}
export function permissionRemembered(request: ApprovalInfo): boolean {
  const key = permissionKey(request);
  return !!key && allowed.has(key);
}
export function forgetPermissions(provider?: CodingProvider, session?: string): void {
  for (const [key, owner] of allowed) if ((!provider || owner.provider === provider) && (!session || owner.session === session)) allowed.delete(key);
}
export function permissionInputKey(input: Record<string, unknown>): string | undefined {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
  const action = Object.fromEntries(Object.entries(input).filter(([key])=>!['description','justification'].includes(key)));
  const key = JSON.stringify(canonical(action));
  return Object.keys(action).length && key.length <= 12000 ? key : undefined;
}
