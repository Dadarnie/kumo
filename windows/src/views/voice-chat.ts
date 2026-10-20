// SPDX-License-Identifier: MIT
import { Bridge } from "../core/bridge";
import { h } from "./dom";
import { ICONS, icon } from "./icons";
import { renderMarkdown } from "./markdown";
import type { VoiceConnection } from "../core/voice-providers";

type VoicePhase = "idle" | "connecting" | "recording" | "transcribing" | "waiting" | "speaking";

/** One explicit microphone turn, released on cancel, navigation or completion. */
export class VoiceChat {
  readonly button = h("button", {
    type: "button", class: "chat-voice-button", title: "Start voice chat",
    "aria-label": "Start voice chat", "aria-pressed": "false",
  }, icon(ICONS.microphone, 15));
  private label = h("span");
  readonly status = h("div", { class: "chat-voice-status", role: "status", "aria-live": "polite", hidden: true },
    this.label, h("span", { class: "chat-voice-disclosure", text: "AI voice" }),
    h("button", { type: "button", class: "chat-voice-cancel", "aria-label": "Cancel voice chat",
      onclick: () => this.cancel() }, icon(ICONS.xmark, 10)));
  private phase: VoicePhase = "idle";
  private revision = 0;
  private recorder?: MediaRecorder;
  private recording?: Promise<Blob>;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  private playback?: HTMLAudioElement;
  private playbackUrl?: string;
  private finishPlayback?: () => void;
  private connection?: VoiceConnection;
  private cancellation: Promise<unknown> = Promise.resolve();
  private meterContext?: AudioContext;
  private meterSource?: AudioNode;
  private meter?: AnalyserNode;
  private meterData?: Uint8Array<ArrayBuffer>;

  get measuredPeak(): number | undefined {
    if (!this.meter || !this.meterData || this.phase !== "recording") return undefined;
    this.meter.getByteTimeDomainData(this.meterData);
    let square = 0;
    for (const value of this.meterData) square += ((value - 128) / 128) ** 2;
    return Math.min(1000, Math.round(Math.sqrt(square / this.meterData.length) * 1000));
  }
  private stopMeter(): void {
    this.meterSource?.disconnect();this.meter?.disconnect();
    this.meterSource = undefined;this.meter = undefined;this.meterData = undefined;
    void this.meterContext?.close().catch(() => {});this.meterContext = undefined;
  }
  private startMeter(source: MediaStream): void {
    this.stopMeter();
    if (typeof AudioContext === "undefined") return;
    try {
      const context = new AudioContext({ latencyHint: "interactive" });
      this.meterContext = context;
      this.meter = context.createAnalyser();this.meter.fftSize = 256;
      this.meterData = new Uint8Array(256);
      this.meterSource = context.createMediaStreamSource(source);
      this.meterSource.connect(this.meter);
      void context.resume().catch(() => {});
    } catch { this.stopMeter(); }
  }

  constructor(
    private reply: (transcript: string) => Promise<string | undefined>,
    private changed: () => void,
    private failed: (message: string) => void,
    private abortReply: () => Promise<unknown> = () => Promise.resolve(),
  ) {
    this.button.addEventListener("click", () => {
      if (this.phase === "recording") void this.finish();
      else if (this.phase !== "idle") this.cancel();
      else void this.start();
    });
  }

  get busy(): boolean { return this.phase !== "idle"; }
  get currentPhase(): VoicePhase { return this.phase; }
  get voiceConnection(): VoiceConnection | undefined { return this.connection; }
  toggle(): void {
    if (this.phase === "recording") void this.finish();
    else if (this.busy) this.cancel();
    else void this.start();
  }
  async prepareDesktop(): Promise<void> { await this.abortReply(); }

  private change(phase: VoicePhase): void {
    this.phase = phase;
    const labels = { idle: "Start voice chat", connecting: "Connecting voice…", recording: "Listening · tap to send",
      transcribing: "Transcribing…", waiting: "Waiting for a reply…", speaking: "Kumo is speaking…" };
    const action = phase === "recording" ? "Send voice message" : phase === "idle" ? labels.idle : "Stop voice chat";
    this.button.title = action;
    this.button.setAttribute("aria-label", action);
    this.button.setAttribute("aria-pressed", String(phase !== "idle"));
    this.button.dataset.phase = phase;
    this.status.hidden = phase === "idle";
    this.label.textContent = labels[phase];
    this.changed();
  }

  private stopMicrophone(): void {
    this.stopMeter();
    clearTimeout(this.timer); this.timer = undefined;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;
    this.recorder = undefined;
  }

  async start(): Promise<void> {
    if (this.busy) return;
    const revision = ++this.revision;
    this.change("connecting");
    try {
      await this.cancellation;
      if (revision !== this.revision) return;
      this.connection = await Bridge.voiceReady();
      if (revision !== this.revision) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("Voice chat needs a microphone supported by Windows WebView2.");
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
        .find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error("This microphone recording format is not supported.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (revision !== this.revision) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.startMeter(stream);
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      const chunks: BlobPart[] = [];
      this.recording = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
        recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: mime })), { once: true });
        recorder.addEventListener("error", () => reject(new Error("The microphone recording stopped. Try again.")), { once: true });
      });
      // A recording error can arrive before the user presses Send.
      this.recording.catch(error => {
        if (revision === this.revision) { this.cancel(); this.failed(String(error).replace(/^Error:\s*/, "")); }
      });
      this.recorder = recorder;
      recorder.start(250);
      this.timer = setTimeout(() => void this.finish(), 60_000);
      this.change("recording");
    } catch (error) {
      if (revision !== this.revision) return;
      this.cancel();
      const denied = error instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(error.name);
      this.failed(denied ? "Allow microphone access to use voice chat. You can still type your message."
        : error instanceof DOMException && error.name === "NotFoundError" ? "Connect a microphone to use voice chat."
        : String(error).replace(/^Error:\s*/, ""));
    }
  }

  private async finish(): Promise<void> {
    if (this.phase !== "recording" || !this.recording) return;
    const revision = this.revision;
    const recording = this.recording;
    this.change("transcribing");
    this.stopMicrophone();
    try {
      const clip = await recording;
      this.recording = undefined;
      if (revision !== this.revision) return;
      if (!clip.size) throw new Error("I couldn't hear a message. Try speaking again.");
      if (clip.size > 4 * 1024 * 1024) throw new Error("Keep voice messages under one minute.");
      const bytes = new Uint8Array(await clip.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      if (revision !== this.revision) return;
      const connection = this.connection!;
      const transcript = await Bridge.voiceTranscribe(btoa(binary), clip.type, connection.provider);
      if (revision !== this.revision) return;
      this.change("waiting");
      const reply = await this.reply(transcript);
      if (revision !== this.revision) return;
      if (!reply || !connection.readReplies) { this.cancel(); return; }
      const content = renderMarkdown(reply);
      content.querySelectorAll("pre").forEach(block => block.remove());
      const spoken = Array.from(content.textContent ?? "").slice(0, 4000).join("").trim();
      if (!spoken) { this.cancel(); return; }
      this.change("speaking");
      const audio = await Bridge.voiceSpeak(spoken, connection.provider);
      if (revision !== this.revision) return;
      const decoded = Uint8Array.from(atob(audio.audio), character => character.charCodeAt(0));
      this.playbackUrl = URL.createObjectURL(new Blob([decoded], { type: audio.mime }));
      const playback = new Audio(this.playbackUrl);
      this.playback = playback;
      const ended = new Promise<void>((resolve, reject) => {
        this.finishPlayback = resolve;
        playback.addEventListener("ended", () => resolve(), { once: true });
        playback.addEventListener("error", () => reject(new Error("The voice reply couldn't play. Its text is still in chat.")), { once: true });
      });
      // Listen before play(), including an immediate decoder failure.
      ended.catch(() => {});
      await playback.play();
      if (revision !== this.revision) return;
      this.change("speaking");
      await ended;
      if (revision === this.revision) this.cancel();
    } catch (error) {
      if (revision !== this.revision) return;
      this.cancel(); this.failed(String(error).replace(/^Error:\s*/, ""));
    }
  }

  cancel(): void {
    const active = this.busy;
    const waiting = this.phase === "waiting";
    ++this.revision;
    this.stopMicrophone(); this.recording = undefined;
    this.playback?.pause();
    this.playback?.removeAttribute("src"); this.playback?.load();
    this.playback = undefined;
    this.finishPlayback?.(); this.finishPlayback = undefined;
    if (this.playbackUrl) URL.revokeObjectURL(this.playbackUrl);
    this.playbackUrl = undefined;
    this.connection = undefined;
    if (active) {
      this.cancellation = Promise.allSettled([Bridge.voiceCancel(), ...(waiting ? [this.abortReply()] : [])]);
      this.change("idle");
    }
  }
}
