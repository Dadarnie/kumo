// SPDX-License-Identifier: MIT
import { CODING_PROVIDERS, type CodingProvider } from "./coding";
import type { CodexUsage, UsageWindow } from "./codex-usage";

export interface ActivityDay { date: string; tokens: number; agents: Partial<Record<CodingProvider, number>> }
export type VoiceActivityPhase = "idle" | "connecting" | "recording" | "transcribing" | "waiting" | "speaking" | "paused" | "error";
interface UsageReading extends CodexUsage { tokens?: number | null }
interface Saved { days: ActivityDay[]; readings: Partial<Record<CodingProvider, UsageReading[]>> }
const KEY = "mimo.activity.v1";
export const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const compactFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export function compactNumber(value: number) { return compactFormatter.format(value); }

/** Only locally observed counts; no invented account quotas or historical activity. */
class ActivityStore {
  private saved: Saved = { days: [], readings: {} };
  private listeners = new Set<() => void>();
  private tokens = new Map<string, number>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  chat = { busy: false, tokens: 0 };
  voice: { active: boolean; phase: VoiceActivityPhase; error: string | null; service: string | null; assistant: string | null } = { active: false, phase: "idle", error: null, service: null, assistant: null };
  setVoice(active: boolean, phase: VoiceActivityPhase = "idle", error: string | null = null) {
    this.voice = { active, phase, error, service: active ? this.voice.service : null, assistant: active ? this.voice.assistant : null };
    this.publish();
  }
  describeVoice(service:string,assistant:string) { this.voice={...this.voice,service,assistant};this.publish(); }
  constructor() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (data && Array.isArray(data.days) && data.readings) {
        const today = data.days.find((d: ActivityDay) => d?.date === dayKey());
        if (today) {
          const agents = Object.fromEntries(CODING_PROVIDERS.flatMap(({id}) => {
            const count = today.agents?.[id];
            return Number.isFinite(count) && count > 0 ? [[id, Math.floor(count)]] : [];
          }));
          this.saved.days = [{ date: today.date, tokens: Number.isFinite(today.tokens) && today.tokens > 0 ? today.tokens : 0, agents }];
        }
        this.saved.readings = Object.fromEntries(CODING_PROVIDERS.map(({id}) => [id, Array.isArray(data.readings[id]) ? data.readings[id].slice(-96) : []]));
      }
    } catch { /* A disabled/corrupt local store never blocks Limits. */ }
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private publish() { for (const fn of this.listeners) fn(); }
  private commit() {
    // Hooks and progress events publish immediately; disk serialization waits
    // until the burst settles, outside the input/animation event handler.
    if (this.persistTimer === null) this.persistTimer = setTimeout(() => this.flush(), 200);
    this.publish();
  }
  flush() {
    if (this.persistTimer === null) return;
    clearTimeout(this.persistTimer); this.persistTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(this.saved)); } catch {}
  }
  private day(key = dayKey()) {
    let day = this.saved.days.find(d => d.date === key);
    if (!day) { day = {date:key,tokens:0,agents:{}}; this.saved.days = [day]; }
    return day;
  }
  get today() { return this.day(); }
  observedTokens(provider: CodingProvider, count: number) {
    if (this.addTokens(provider,count)) this.commit();
  }
  private addTokens(provider: CodingProvider, count: number) {
    if (!Number.isFinite(count) || count <= 0 || count > 1e9) return false;
    const day=this.day(); day.tokens+=Math.floor(count); day.agents[provider]=(day.agents[provider]??0)+Math.floor(count); return true;
  }
  observeUsage(provider: CodingProvider, value: CodexUsage | null) {
    if (!value || !Number.isFinite(value.checkedAt)) return;
    const readings=this.saved.readings[provider]??[];
    if (readings.at(-1)?.checkedAt===value.checkedAt) return;
    this.saved.readings[provider]=[...readings,value].slice(-96); this.commit();
  }
  latest(provider: CodingProvider) { return this.saved.readings[provider]?.at(-1) ?? null; }
  readings(provider: CodingProvider) { return this.saved.readings[provider] ?? []; }
  observeHook(provider: CodingProvider, payload: Record<string, unknown>) {
    const event=String(payload.hook_event_name??"");
    const sessionId=String(payload.session_id??provider);
    const key=`${provider}:${sessionId}`;
    let changed = false;
    const reported=payload.mimo_usage as {totalTokens:number;cumulative:boolean} | undefined;
    if(reported&&Number.isFinite(reported.totalTokens)) {
      if(reported.cumulative){const previous=this.tokens.get(key)??0;if(reported.totalTokens>previous)changed=this.addTokens(provider,reported.totalTokens-previous);this.tokens.set(key,Math.max(previous,reported.totalTokens));}
      else changed=this.addTokens(provider,reported.totalTokens);
      if (event==="SessionEnd") this.tokens.delete(key);
      if (changed) this.commit();return;
    }
    const usage=payload.usage as Record<string,unknown> | undefined;
    const metadata=(payload.usageMetadata??(payload.llm_response as Record<string,unknown> | undefined)?.usageMetadata) as Record<string,unknown> | undefined;
    const raw=usage?.total_tokens ?? metadata?.totalTokenCount ?? payload.total_tokens;
    const count=Number(raw??(usage ? Number(usage.input_tokens??0)+Number(usage.output_tokens??0):NaN));
    if (Number.isFinite(count) && count>=0) { const previous=this.tokens.get(key)??0; if(count>previous)changed=this.addTokens(provider,count-previous); this.tokens.set(key,count); }
    if (event==="SessionEnd") this.tokens.delete(key);
    if (changed) this.commit();
  }
  chatStarted() { this.chat={busy:true,tokens:0}; this.publish(); }
  chatFinished(tokens: number | null = null) { this.chat={busy:false,tokens:tokens??0}; this.publish(); }
}
export const Activity = new ActivityStore();

export function limitForecast(readings: CodexUsage[], index: "primary" | "secondary" = "primary", now = Date.now()) {
  const latest=readings.at(-1); const window=latest?.[index];
  if (!latest || !window) return "This agent doesn’t share a rate-limit window.";
  if (window.resetsAt && window.resetsAt*1000<=now) return "Reset time has passed. Refresh your usage.";
  if (now-latest.checkedAt*1000>15*60*1000) return "Reading is stale. Refresh to estimate your remaining time.";
  if (window.usedPercent>=100) return "Limit reached. Wait for the next reset.";
  const first=readings.find(r=>r.checkedAt<latest.checkedAt-60 && latest.checkedAt-r.checkedAt<=6*3600
    && r[index]?.resetsAt===window.resetsAt && r[index]?.windowMinutes===window.windowMinutes && r[index]!.usedPercent<window.usedPercent);
  if (!first) return "One more reading is needed to estimate your pace.";
  const rate=(window.usedPercent-first[index]!.usedPercent)/((latest.checkedAt-first.checkedAt)/3600);
  const by=now+(100-window.usedPercent)/rate*3600*1000;
  if (!Number.isFinite(by)) return "No recent increase in usage.";
  if (window.resetsAt && by>=window.resetsAt*1000) return "At this rate, the window resets before you run out.";
  return "At this rate, you’ll run out by "+new Date(by).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})+" (estimate).";
}
export function highestWindow(value: CodexUsage | null): UsageWindow | null { return [value?.primary,value?.secondary].filter((w):w is UsageWindow=>!!w).sort((a,b)=>b.usedPercent-a.usedPercent)[0]??null; }
