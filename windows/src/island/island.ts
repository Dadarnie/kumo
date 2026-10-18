// SPDX-License-Identifier: MIT
// The island: DOM shell, sizing animation, Mimo placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Lifetime } from "../core/lifetime";
import { applyAppearance } from "../core/appearance";
import { resizeCanvas } from "../core/canvas";
import { Bridge, IS_TAURI, onDragDrop, onEvent, type CursorSample, type IslandPositionInfo } from "../core/bridge";
import { MimoQuickMenu } from "./quick-menu";
import "./companion.css";
import {
  EXPANDED_CORNER,
  EXPANDED_W,
  MEDIA_HOVER_W,
  MEDIA_HOVER_H,
  NOTCH_W,
  PANEL_H,
  PANEL_W,
  PEEK_H,
  ROUNDED_CORNER,
  VIEW_LAYOUTS,
  botPosition,
  chatPromptHeight,
  islandSize,
  type IslandVisibility,
  type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { CODING_IDS, codingConnections, codingProvider } from "../core/coding";
import { State, type AgentTask } from "../core/state";
import { prefersReducedMotion, reducedMotionQuery } from "../core/motion";
import { attachChatFiles, MAX_CHAT_FILES } from "../core/chat-attachments";
import { BotEngine, hexToRGB, type RGB } from "../mimo/engine";
import { mimoAppStatus } from "../mimo/status";
import { companionStateForView, expressionForContext, musicPerformanceActive, MIMO_EXPRESSIONS } from "../mimo/expressions";
import { MIMO_APPS } from "../mimo/brands";
import { MIMO_PICKER_COLORS, MIMO_PALETTE } from "../mimo/palette";
import { mimoCursorGaze } from "../mimo/cursor";
import { Greeting } from "../mimo/greeting";
import {
  miniBotsBusy,
  nextMiniBotWakeDelayMs,
  pruneMiniBots,
  syncMiniBotStates,
  pauseMiniBotAnimations,
  tickMiniBots,
} from "../mimo/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import {
  buildHeader,
  buildViews,
  type ViewActions,
  type ViewHost,
} from "../views/views";
import { h } from "../views/dom";
import { mediaStore } from "../core/media-store";
import { ActivityStrip } from "./activity-strip";
import { ACTIVITY_SETTLE_MS, Visibility } from "../core/visibility";
import { Activity } from "../core/activity";
import type { VoiceChat } from "../views/voice-chat";
import { IslandWindowBounds } from "./window-bounds";
import { buildHome, buildMediaPage } from "../views/sections";
import { safeSectionView, ownsContent } from "../core/sections";
import { ModuleOverview } from "../views/overview";
import { buildGrab } from "../views/grab";
import { buildUsage } from "../views/codex-usage";
import { cancelApprovalTimeout, expireApprovals } from "./hooks";
import { IslandMedia, type CoreMediaMode } from "./media";
import "./core.css";

const BOT_OVERHANG = 40;
// Retain one DPI-sized buffer while the head changes size; resizing a Canvas
// during every spring frame clears its pixels and reallocates the backing store.
const BOT_CANVAS_EDGE = 128;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;
const FILE_DRAG_MARGIN = 8;
const FILE_APPROACH_MARGIN = 32;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set([
  "upload",
  "uploading",
  "choose",
]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandVisibility) =>
  m === "peek" ? 0 : m === "island" ? 1 : 2;

export class Island {
  readonly visibility = Visibility;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private patTarget!: HTMLButtonElement;
  private companionColorHex: string | null = null;
  private companionColor: RGB | null = null;
  private grabDetached = false;
  private desktopVoice?: VoiceChat;
  private voiceOrigin: { view: IslandViewName; visibility: IslandVisibility } | null = null;
  private voiceOpening = false;

  async toggleDesktopVoice(): Promise<void> {
    if (this.disposed || this.voiceOpening) return;
    if (!Activity.voice.active) this.voiceOrigin = { view: State.view, visibility: State.visibility };
    if (State.pendingApproval) {
      Activity.setVoice(true, "paused");
      this.desktopVoice?.cancel();
      void Bridge.setVoiceActive(false);
      this.expand("approval");
      return;
    }
    this.voiceOpening = true;
    const openVoicePanel = () => {
      // Visibility already supplies this cue when the compact island expands.
      if (State.visibility === "expanded" && State.view !== "voice") Sound.play("open");
      this.expand("voice");
    };
    try {
      if (this.grabDetached) {
        await Bridge.grabAction("dock");
        if (this.disposed) return;
        this.setGrabDetached(false);
      }
      Activity.setVoice(true);
      this.setGrabModifier(false);
      const prompt = this.views.get("prompt")!;
      prompt.setVisible?.(true);
      this.desktopVoice = prompt.voice;
      prompt.setVisible?.(false);
      if (!this.desktopVoice) throw new Error("Voice control could not open. Try again.");
      if (!this.desktopVoice.busy) await this.desktopVoice.prepareDesktop();
      if (this.disposed || !Activity.voice.active) return;
      State.chatError = "";
      State.fileDragOver = false;this.fileDragOrigin = null;this.engine.animateMorph(0);
      openVoicePanel();
      void Bridge.setVoiceActive(true);
      this.desktopVoice.toggle();
    } catch (error) {
      if (!this.disposed) {
        Activity.setVoice(true, "error", String(error).replace(/^Error:\s*/, ""));
        openVoicePanel();
        Sound.play("error");
      }
    } finally { this.voiceOpening = false; }
  }

  closeDesktopVoice(): void {
    if (!Activity.voice.active) return;
    Activity.setVoice(false);
    this.desktopVoice?.cancel();
    void Bridge.setVoiceActive(false, true);
    const origin = this.voiceOrigin;
    this.voiceOrigin = null;
    // Returning to an expanded panel does not trigger Visibility's close cue.
    if (State.visibility === "expanded" && (State.pendingApproval || origin?.visibility === "expanded")) Sound.play("close");
    const view = State.pendingApproval ? "approval" : origin && UPLOAD_VIEWS.has(origin.view) ? "prompt" : origin?.view === "approval" || origin?.view === "voice" ? State.defaultView() : origin?.view ?? State.defaultView();
    this.setView(view);
    if (!State.pendingApproval && origin?.visibility !== "expanded") Visibility.island();
  }
  private grabModifier = false;
  private grabReturnHover = false;
  private grabReturning = false;
  private grabReturnTimer?: ReturnType<typeof setTimeout>;
  private grabGeometrySentAt = 0;
  private grabGeometryPending = false;
  private grabDrag: {x:number;y:number;dragged:boolean;ready:Promise<unknown>|null} | null = null;
  private suppressGrabClick = false;
  setGrabDetached(value:boolean):void {
    this.grabDetached=value;
    this.islandEl.dataset.grabDetached=String(value);
    if(!value){
      clearTimeout(this.grabReturnTimer);this.grabReturning=false;this.grabDrag=null;
      this.setGrabReturnHover(false);Visibility.setDragging(false);Visibility.setGrabReady(this.grabModifier);
    }
    this.dirty=true;this.ensureRunning();
  }
  setGrabReturnHover(value:boolean):void {
    if(this.disposed||this.grabReturnHover===value)return;
    this.grabReturnHover=value;this.islandEl.dataset.grabReturnHover=String(value);
    this.animateGeometry(!value);this.ensureRunning();
  }
  prepareGrabReturn(captured:boolean):void {
    if(this.disposed||!this.grabDetached)return;
    this.grabReturning=true;this.setGrabReturnHover(true);
    if(captured)this.open("grab");
    this.updateBotTargets();
    clearTimeout(this.grabReturnTimer);
    // Let the native envelope grow before handing over the final visible slot.
    // The detached surface then lands at the same size and point as this canvas.
    this.grabReturnTimer=setTimeout(()=>{
      if(this.disposed||!this.grabDetached||!this.grabReturning)return;
      this.publishGrabReturnGeometry();
    },16);
    this.dirty=true;this.ensureRunning();
  }
  private publishGrabReturnGeometry():void {
    if(this.grabGeometryPending||!this.grabDetached||!this.grabReturning||this.disposed)return;
    this.grabGeometryPending=true;this.grabGeometrySentAt=performance.now();
    const rect=this.islandRect();
    void Bridge.grabAction("return_geometry",{
      x:rect.x+this.botCx.value,y:rect.y+this.botCy.value+this.botSize.value*.018,renderSize:this.botSize.value,
    }).catch(()=>{}).finally(()=>{this.grabGeometryPending=false;});
  }
  setGrabModifier(value:boolean):void {
    value=value&&State.settings.grabEnabled&&!Activity.voice.active;
    if(this.disposed||this.grabModifier===value)return;
    this.grabModifier=value;
    Visibility.setGrabReady(value||!!this.grabDrag?.dragged);
    if(value&&State.visibility!=="expanded"){
      this.coreMode=null;this.hoverExpanded=false;this.holdCompactControls(true);
    }
    this.islandEl.dataset.grabReady=String(value);
    this.dirty=true;this.ensureRunning();
  }
  receiveGrabDrop(paths:string[]):void {this.open("overview");this.onDragDrop({type:"drop",paths},true);}
  private greetingCanvas!: HTMLCanvasElement;
  private countdown!: HTMLElement;
  private restoreTarget!: HTMLButtonElement;
  private activity!: ActivityStrip;
  private coreRim!: SVGSVGElement;
  private coreRimPath!: SVGPathElement;
  private coreMode: CoreMediaMode = null;
  private compactControlsHeld = false;
  private quickMenu: MimoQuickMenu | null = null;
  private hoverExpanded = false;
  private cursorPosition: { x: number; y: number } | null = null;
  private cursorDesktop = false;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private media!: IslandMedia;
  private overview!: ModuleOverview;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private mediaSpace = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private positionX = new Tracked(window.innerWidth / 2);
  private positionY = new Tracked(0);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);
  private greetingPending = false;

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private disposed = false;
  private lifetime = new Lifetime();
  private raf: number | undefined;
  private mascotVisible = true;
  private lastFrame = 0;
  private dirty = true;
  private ambientTimer: ReturnType<typeof setTimeout> | undefined;

  private windowBounds = new IslandWindowBounds(async (visibility) => {
    await Bridge.setVisibility(visibility);
    // Native resizing resets hit testing. Re-send even an unchanged shape after
    // the command finishes, including startup in the already expanded window.
    this.pushedRect = { x: -1, y: -1, w: -1, h: -1, r: -1 };
    this.ensureRunning();
  });
  private subscriptions: (() => void)[] = [];
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1, r: -1 };

  // Pointer strokes show affection; three separate pokes retain confusion.
  private botHovering = false;
  private lastHoverPat = 0;
  private hoverPatDirection: { x: number; y: number } | null = null;
  private lastLoveTime = -Infinity;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;
  private keyboardActive = false;
  private workShortcutActive = false;
  private previousPlaying = false;
  private previousTrack = "";
  private geometryHeight = 0;
  private appliedGeometry = "";

  /** Drop sequence bookkeeping: one gulp, progress ticks, and completion. */
  private uploadTens = 0;
  private uploadDone = false;
  private uploadGulped = false;
  private fileDragOrigin: { view: IslandViewName; visibility: IslandVisibility } | null = null;
  private fileApproaching = false;
  private homeReturnHeld = false;

  constructor(root: HTMLElement) {
    this.root = root;
    // Empty WebView space must never become a DOM pointer target behind the lip.
    this.root.style.pointerEvents = "none";
    this.build();
    window.addEventListener("pagehide", () => this.destroy(), { once: true, signal: this.lifetime.signal });
    import.meta.hot?.dispose(() => this.destroy());
    this.wireVisibility();
    this.wireInput();
    const motion = reducedMotionQuery();
    const motionChanged = () => this.ensureRunning();
    motion.addEventListener("change", motionChanged);
    this.subscriptions.push(() => motion.removeEventListener("change", motionChanged));
    this.engine.onDizzy = () => this.handleDizzy();
    this.engine.onWake = () => {
      if (State.visibility !== "peek") this.ensureRunning();
    };
    this.greeting.onComplete = () => {
      if (State.view !== "greeting") return;
      State.view = State.defaultView();
      this.animateGeometry(false);
      State.notify();
    };
    this.subscriptions.push(
      State.subscribe(() => {
        Visibility.setWorking(this.codingWorkActive);
        this.dirty = true;
        this.ensureRunning();
      }),
    );
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.destroy();
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
    this.running = false;
    clearTimeout(this.ambientTimer);
    clearTimeout(this.grabReturnTimer);
    this.quickMenu?.destroy();
    this.engine.destroy();
    Activity.setVoice(false);
    this.desktopVoice?.cancel();
    void Bridge.setVoiceActive(false);
    this.greeting.interrupt();
    this.greeting.onComplete = null;
    UploadSeq.deactivate();
    this.uploadCanvas.destroy();
    this.media.destroy();
    this.header.destroy?.();
    for (const view of this.views.values()) view.destroy?.();
    this.activity.destroy();
    this.windowBounds.destroy();
    this.subscriptions.splice(0).forEach((stop) => stop());
    Visibility.destroy();
    if (this.confusedRecovery !== null) clearTimeout(this.confusedRecovery);
    this.islandEl.remove();
    pruneMiniBots();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      returnHome: () => this.returnHome(),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        if (State.pendingApproval?.taskId === id) this.setView(State.pendingReviewView);
        Sound.play("blip");
      },
      openTerminal: (project?: string | null) => {
        const cwd = project === undefined ? State.focusTask?.sessionCwd ?? null : project;
        const target=State.tasks.find(t=>t.sessionCwd===cwd && t.id===State.focusId)?.returnTarget;
        if (!cwd) {void Bridge.openInVSCode(null);return;}
        actions.returnToWork(cwd,target);
      },
      returnToWork: (cwd,target) => {
        void Bridge.returnToWork(target ?? null,cwd);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (codingProvider(task))
          actions.openTerminal(task.sessionCwd ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => this.decideApproval(d),
      answerQuestion: (id,answers) => this.answerQuestion(id,answers),
      returnQuestion: () => this.returnQuestion(),
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: page => void Bridge.openSettingsWindow(page),
      toggleVoice: () => void this.toggleDesktopVoice(),
      closeVoice: () => this.closeDesktopVoice(),
      voicePeak: () => this.desktopVoice?.measuredPeak,
      openTool: id => {
        State.setFocus(id);
        const task = State.focusTask;
        if (codingProvider(task) && task && (task.sessionId || task.activity)) State.selectCodingTask(task.id);
        this.overview.choose(codingProvider(task) ? CODING_IDS.claude : id, false);
        this.setView("integrations");
      },
      blip: () => Sound.play("blip"),
    };

    this.restoreTarget = h("button", {
      id: "restore-island",
      type: "button",
      "aria-label": "Open Mimo",
      title: "Open Mimo · Right-click for controls",
      onclick: event => {
        event.preventDefault();
        if (this.media.available && !ownsContent(State.view)) {
          this.openMedia();
          return;
        }
        this.expand(State.defaultView());
      },
    });
    this.restoreTarget.addEventListener("pointerenter", event => {
      if (!IS_TAURI || State.visibility === "peek") this.onCursor(event.clientX, event.clientY,{x:event.clientX,y:event.clientY,control:event.ctrlKey});
    });
    this.activity = new ActivityStrip(task => this.reviewCodingTask(task));
    this.botCanvas = h("canvas", { id: "bot-canvas", role: "img", "aria-label": "Mimo companion" });
    this.patTarget = h("button", { id: "pat-mimo", type: "button", "aria-label": "Mimo companion",
      hidden: "", onclick: event => {
        if (State.view === "voice") { void this.toggleDesktopVoice(); return; }
        if(this.suppressGrabClick){this.suppressGrabClick=false;return;}
        if (State.visibility === "peek") {
          if (this.media.available && !ownsContent(State.view)) this.openMedia();
          else this.expand(State.defaultView());
          return;
        }
        Sound.resume(); State.lastActivity = performance.now();
        const tap = event as MouseEvent, rect = this.patTarget.getBoundingClientRect();
        const direction = tap.detail > 0 && tap.clientX > rect.left + rect.width / 2 ? -1 : 1;
        this.cancelBotHover(); this.engine.slap(direction);
      }, onkeydown: event => {
        const e = event as KeyboardEvent;
        if (e.key !== "Enter" || !e.shiftKey || e.repeat) return;
        e.preventDefault(); Sound.resume(); State.lastActivity = performance.now();
        if (this.engine.pat()) this.lastLoveTime = performance.now() / 1000;
      } });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.patTarget.addEventListener("pointerdown",event=>{
      if(event.button!==0||Activity.voice.active||!State.settings.grabEnabled||this.grabDetached||State.visibility!=="expanded"&&!event.ctrlKey)return;
      if(event.ctrlKey)this.setGrabModifier(true);
      this.grabDrag={x:event.clientX,y:event.clientY,dragged:false,ready:null};
      this.patTarget.setPointerCapture(event.pointerId);
    });
    // Window listeners keep the gesture alive when WebView2 loses pointer capture.
    window.addEventListener("pointermove",event=>this.beginGrabDrag(event.clientX,event.clientY),{signal:this.lifetime.signal});
    window.addEventListener("pointerup",()=>{
      const drag=this.grabDrag;this.grabDrag=null;
      if(!drag?.dragged){Visibility.setGrabReady(this.grabModifier);return;}
      this.suppressGrabClick=true;
      // Native cursor tracking also finishes a drop outside the WebView.
      void drag.ready?.then(()=>Bridge.grabAction("capture_target")).then(()=>{
        if(!IS_TAURI){this.setGrabDetached(false);this.open("grab");}
      }).catch(error=>this.grabFailed(error));
    },{signal:this.lifetime.signal});
    this.patTarget.addEventListener("pointercancel",()=>{
      // Once detached, native tracking owns release even when pointer capture is lost.
      if(!this.grabDrag?.dragged)this.grabDrag=null;
    });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.media = new IslandMedia((shrinking) => {
      this.dirty = true;
      this.animateGeometry(shrinking);
    });
    this.overview = new ModuleOverview(actions);
    this.views = buildViews(
      actions,
      () => this.animateGeometry(false),
      buildHome(actions, this.overview),
    );
    this.views.set("media", buildMediaPage(this.media));

    this.views.set("usage", buildUsage(actions));
    this.views.set("grab", buildGrab(actions));
    this.coreRim = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.coreRim.classList.add("core-rim");
    this.coreRim.setAttribute("aria-hidden", "true");
    this.coreRimPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.coreRim.append(this.coreRimPath);
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h(
      "div",
      { id: "content" },
      this.header.el,
      this.viewsEl,
      this.media.rowEl,
    );

    // The drop sequence draws the card, the bar and its own Mimo. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        if (State.chatAttachmentLoading || !State.droppedFiles.length) return;
        this.setView("prompt");
      },
      cancel: () => { State.clearAttachment(); this.setView(State.defaultView()); },
      shelf: () => {
        if(State.chatAttachmentLoading||State.droppedFiles.length!==1)return;
        const path=State.droppedFiles[0].path;
        void Bridge.grabAction("import",{path}).then(result=>{if(result){State.clearAttachment();this.setView("grab");}})
          .catch(error=>{State.chatError=String(error);State.notify();});
      },
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
      this.media.ambientEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botCanvas,
      this.patTarget,
      this.countdown,
      this.restoreTarget,
      this.activity.el,
      this.coreRim,
    );
    this.islandEl.style.pointerEvents = "auto";

    resizeCanvas(this.greetingCanvas, EXPANDED_W, 150);

    this.islandEl.addEventListener("pointerleave", event => {
      if (!IS_TAURI || State.visibility === "peek") this.onCursor(event.clientX, event.clientY);
    });
    for (const event of ["focusin", "focusout"])
      this.islandEl.addEventListener(event, (e) => {
        if (event === "focusin" && State.visibility === "island" &&
          (e.target as HTMLElement).closest(".media-ambient-controls,.activity-review")) {
          this.holdCompactControls(true);
          Visibility.pointerEntered(true);
        }
        if (event === "focusout" && this.compactControlsHeld &&
          (e.target as HTMLElement).closest(".media-ambient-controls,.activity-review")) queueMicrotask(() => {
          if (!this.media.ambientEl.contains(document.activeElement) && !document.activeElement?.closest(".activity-review") && !this.wasInIsland)
            this.leaveIsland();
        });
        this.dirty = true;
        this.ensureRunning();
      });
    this.root.append(this.islandEl);
    this.applyGeometry();
  }

  // ── Visibility ──────────────────────────────────────────────────────────────

  private wireVisibility() {
    this.subscriptions.push(
      Visibility.subscribePresentation(() => {
        this.dirty = true;
        this.animateGeometry(Visibility.compact);
      }),
      mediaStore.subscribe((snapshot) => {
        Visibility.setWorking(this.codingWorkActive);
        Visibility.setMediaPlaying(
          State.settings.modules.media &&
            snapshot.state.playbackState === "playing",
        );
        const playing = State.settings.modules.media && snapshot.state.playbackState === "playing";
        const changedPlayback = this.previousPlaying !== playing;
        const track = JSON.stringify([snapshot.state.sourceAppId, snapshot.state.title, snapshot.state.artist]);
        const changedTrack = this.previousTrack !== track;
        this.previousPlaying = playing;
        this.previousTrack = track;
        if (playing && changedTrack && !changedPlayback && State.visibility === "expanded"
          && State.view === "media" && !State.pendingApproval) {
          this.engine.setExpressionContext("music");
          this.engine.triggerExpression("dancing", 1.6);
          this.dirty = true;
          this.ensureRunning();
        }
        if (this.coreMode && !this.media.available) {
          this.coreMode = null;
          State.view = "overview";
          State.notify();
        }
        this.activity.sync(this.compactControlsHeld);
        if (changedPlayback) {
          this.dirty = true;
          this.animateGeometry(!playing);
        }
      }),
      Visibility.subscribe((previous, next) => {
        if (next !== "expanded") this.hoverExpanded = false;
        if (next === "expanded") {
          Sound.play("open");
          if (!this.coreMode) {
            this.engine.setState(State.effectiveState);
            this.engine.rise();
          }
          if (this.hoverExpanded) this.startGreetingOnHover();
        }
        if (previous === "expanded") {
          Sound.play("close");
          State.isPinned = false;
          Visibility.setPinned(false);
          void Bridge.focusWindow(false);
        }
        if (next !== "expanded") {
          this.coreMode = null;
          this.greeting.interrupt();
          if (State.view === "greeting" || State.view === "settings") State.view = State.defaultView();
          this.engine.resetMorph();
          UploadSeq.deactivate();
        }
        State.settings.lastVisibility = next;
        this.windowBounds.transition(previous, next, this.reducedMotion);
        this.animateGeometry(modeOrder(next) < modeOrder(previous));
        State.notify();
      }),
    );
  }

  private get reducedMotion(): boolean {
    return prefersReducedMotion();
  }

  private beginGrabDrag(x:number,y:number):void {
    const drag=this.grabDrag;
    if(!State.settings.grabEnabled||!drag||drag.dragged||Math.hypot(x-drag.x,y-drag.y)<14)return;
    drag.dragged=true;this.suppressGrabClick=true;
    Visibility.setDragging(true);Visibility.setGrabReady(true);
    const rect=this.islandRect(),renderSize=this.botSize.value;
    const sourceX=rect.x+this.botCx.value,sourceY=rect.y+this.botCy.value+renderSize*.018;
    drag.ready=Bridge.grabAction("detach",{color:this.companionColorHex??"",state:this.engine.state,pointer:true,
      returnX:sourceX,returnY:sourceY,renderSize,
      anchorX:drag.x-sourceX,anchorY:drag.y-sourceY,
      pose:{yaw:this.engine.yaw,pitch:this.engine.pitch,tilt:this.engine.tilt,sx:this.engine.sx,sy:this.engine.sy},
      badge:this.engine.badge});
    void drag.ready.catch(error=>this.grabFailed(error));
  }

  private grabFailed(error:unknown):void {
    this.setGrabDetached(false);this.open("grab");
    document.dispatchEvent(new CustomEvent("grab-client-error",{detail:String(error).replace(/^Error: /,"")}));
  }

  private holdCompactControls(hold: boolean): void {
    if (this.compactControlsHeld === hold) return;
    this.compactControlsHeld = hold;
    this.media.setCompactControlsHeld(hold);
    this.activity.sync(hold);
    this.dirty = true;
    this.animateGeometry(!hold);
  }

  private leaveIsland(): void {
    this.wasInIsland = false;
    if ((State.visibility === "island" || this.coreMode === "hover") &&
      (this.media.ambientEl.contains(document.activeElement) || document.activeElement?.closest(".activity-review")) &&
      document.activeElement?.matches(":focus-visible")) {
      Visibility.pointerEntered(true);
      return;
    }
    this.holdCompactControls(false);
    Visibility.pointerLeft();
  }

  private get codingWorkActive(): boolean {
    return State.settings.modules.vscode && !State.paused && State.tasks.some(task =>
      !!codingProvider(task) && !!(task.sessionId || task.activity) &&
      ["working", "thinking", "searching"].includes(task.state));
  }

  private openMedia(): void {
    if (!this.media.available) return;
    this.holdCompactControls(false);
    this.greetingPending = false;
    this.expand("media");
  }

  launch() {
    Visibility.restore(State.settings);
    this.windowBounds.transition(State.visibility, State.visibility, true);
    this.greetingPending = true;
    State.view = State.defaultView();
    this.engine.setState(State.effectiveState);
    this.animateGeometry(false);
    State.notify();
  }

  /** One greeting on the first Home hover, entirely inside the expanded shell. */
  private startGreetingOnHover(): void {
    if (!this.greetingPending || State.visibility !== "expanded" || this.coreMode
      || State.pendingApproval || ownsContent(State.view) || State.view !== State.defaultView()) return;
    this.greetingPending = false;
    this.greeting.start();
    State.view = "greeting";
    this.animateGeometry(false);
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return (
      State.visibility === "expanded" &&
      UploadSeq.isActive &&
      UPLOAD_VIEWS.has(State.view)
    );
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName, hovered = false) {
    if (view !== "overview") this.homeReturnHeld = false;
    if (Activity.voice.active && (view === "approval" || view === "question")) {
      Activity.setVoice(true, "paused");
      this.desktopVoice?.cancel();
      void Bridge.setVoiceActive(false);
    } else if (Activity.voice.active && view !== "voice") {
      Activity.setVoice(false);
      this.desktopVoice?.cancel();
      void Bridge.setVoiceActive(false);
    }
    if (!hovered) this.greetingPending = false;
    view = safeSectionView(view, State.settings.modules, State.settings.activeIntegrations.length,
      State.settings.usageEnabled, Object.values(codingConnections(State.settings, State.tasks)).some(Boolean));
    if (State.pendingApproval && !["settings","approvals","overview","prompt","usage","grab"].includes(view)) view = State.pendingReviewView;
    if (view === "settings") {
      void Bridge.openSettingsWindow();
      return;
    }
    this.hoverExpanded = hovered;
    this.coreMode = null;
    this.holdCompactControls(false);
    this.stopSequenceIfLeaving(view);
    State.view = view;
    Visibility.setProtected(this.homeReturnHeld || ownsContent(view) || State.fileDragOver);
    if (State.visibility !== "expanded") Visibility.expand();
    else this.animateGeometry(false);
    State.lastActivity = performance.now();

    State.notify();
  }

  setView(view: IslandViewName) {
    if (view !== "overview") this.homeReturnHeld = false;
    if (Activity.voice.active && !State.pendingApproval) view = "voice";
    this.greetingPending = false;
    view = safeSectionView(view, State.settings.modules, State.settings.activeIntegrations.length,
      State.settings.usageEnabled, Object.values(codingConnections(State.settings, State.tasks)).some(Boolean));
    if (State.pendingApproval && !["settings","approvals","overview","prompt","usage","grab"].includes(view)) view = State.pendingReviewView;
    if (view === "settings") {
      this.expand(view);
      return;
    }
    this.hoverExpanded = false;
    this.coreMode = null;
    this.holdCompactControls(false);
    const wasExpanded = State.visibility === "expanded";
    this.stopSequenceIfLeaving(view);
    Visibility.setProtected(this.homeReturnHeld || ownsContent(view) || State.fileDragOver);
    if (!wasExpanded) {
      Visibility.expand();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  private returnHome() {
    this.homeReturnHeld = true;
    this.expand("overview");
  }

  collapse() {
    this.homeReturnHeld = false;
    if (Activity.voice.active && !State.pendingApproval) { this.closeDesktopVoice(); return; }
    if (State.pendingApproval) {
      this.expand(State.pendingReviewView, true);
      return;
    }
    cancelApprovalTimeout();
    this.workShortcutActive = false;
    State.pendingApproval = null;
    State.isPinned = false;
    Visibility.setPinned(false);
    Visibility.minimize();
  }

  /** Explicit tray/header navigation always opens; background alerts obey preferences. */
  open(view: IslandViewName = State.defaultView()) {
    this.expand(view);
  }
  private reviewCodingTask(task: AgentTask): void {
    expireApprovals(this);
    const approval = State.pendingApprovals.find(request => request.taskId === task.id);
    State.selectCodingTask(task.sessionId || task.activity ? task.id : null);
    State.setFocus(task.id);
    if (approval) {
      State.selectApproval(approval.requestId);
      this.expand(State.pendingReviewView);
    } else if (task.state === "question") this.expand("question");
    else {
      this.overview.choose(CODING_IDS.claude, false);
      this.expand("overview");
      this.overview.review();
      State.notify();
    }
    void Bridge.focusWindow(true);
  }
  openNextWork() {
    expireApprovals(this);
    this.workShortcutActive = true;
    const next=State.pendingApprovals[0];
    if (next) {State.selectApproval(next.requestId);if(next.taskId) State.setFocus(next.taskId);this.expand(State.pendingReviewView);}
    else if (State.approvalCount) this.expand("approvals");
    else {
      const recent = State.codingTask;
      if (recent) State.setFocus(recent.id);
      this.overview.choose(CODING_IDS.claude);
      this.expand("overview");
    }
    void Bridge.focusWindow(true).then(()=>requestAnimationFrame(()=>{
      if (!this.workShortcutActive || State.visibility !== "expanded") return;
      const controls=[...this.views.get(State.view)!.el.querySelectorAll<HTMLElement>('button:not([hidden]):not([disabled])')];
      controls.find(control=>control.getClientRects().length>0 && !control.closest('[hidden],[inert]'))?.focus();
    }));
  }
  alert(view: IslandViewName, userInteraction = false) {
    if (Activity.voice.active && view !== "approval" && view !== "question") { State.notify(); return; }
    if ((view === "approval" || view === "question") && State.pendingApproval) {
      Visibility.setPinned(true);
      this.expand(State.pendingReviewView);
      return;
    }
    if (
      !userInteraction &&
      State.visibility === "expanded" &&
      State.view !== view &&
      ownsContent(State.view)
    )
      return;
    if (!Visibility.requestExpansion()) return;
    Visibility.setPinned(State.isPinned);
    this.expand(view);
  }
  reveal() {
    State.notify();
  }
  dropPin() {
    Visibility.setPinned(false);
  }

  private decideApproval(decision: "allow" | "deny") {
    const request = State.pendingApproval;
    if (!request || request.questions) return;
    if ((request.deadline ?? Infinity)<=Date.now()) {expireApprovals(this);return;}
    cancelApprovalTimeout(request.requestId);
    Sound.play(decision === "deny" ? "blip" : "approve");
    void Bridge.approvalDecision(request.requestId, decision);
    State.finishApproval(request.requestId);
    State.isPinned = State.pendingApprovals.length > 0;
    Visibility.setPinned(State.isPinned);
    State.updateTask(request.taskId ?? "integration_claude", "working");
    State.setPillBadge(request.taskId ?? "integration_claude", null);
    if (State.pendingApproval?.taskId) State.setFocus(State.pendingApproval.taskId);
    this.setView(State.pendingApproval ? State.pendingReviewView : State.defaultView());
  }

  private async answerQuestion(id: string, answers: Record<string,string>): Promise<void> {
    const request=State.pendingApprovals.find(request=>request.requestId===id);
    if (!request?.questions || (request.deadline ?? 0)<=Date.now()) {
      expireApprovals(this);throw new Error('This question has returned to your tool.');
    }
    await Bridge.questionAnswer(id,answers);
    // A result, timeout or session closure may have arrived while the bridge ran.
    if (!State.pendingApprovals.some(request=>request.requestId===id)) return;
    cancelApprovalTimeout(id);State.finishApproval(id);
    State.updateTask(request.taskId ?? 'integration_claude','working');
    State.setPillBadge(request.taskId ?? 'integration_claude',null);
    State.isPinned=State.pendingApprovals.length>0;Visibility.setPinned(State.isPinned);
    if (State.pendingApproval?.taskId) State.setFocus(State.pendingApproval.taskId);
    this.setView(State.pendingApproval ? State.pendingReviewView : State.defaultView());
  }

  private returnQuestion(): void {
    const request=State.pendingApproval?.questions ? State.pendingApproval : null;
    const task=State.focusTask;
    if (request) {
      cancelApprovalTimeout(request.requestId);void Bridge.approvalDecline(request.requestId);
      State.rememberApproval(request,'Answer in tool');State.finishApproval(request.requestId);
      State.isPinned=State.pendingApprovals.length>0;Visibility.setPinned(State.isPinned);
    }
    void Bridge.returnToWork(request?.returnTarget ?? task?.returnTarget ?? null,request?.cwd ?? task?.sessionCwd ?? null);
    if (State.pendingApproval?.taskId) State.setFocus(State.pendingApproval.taskId);
    this.setView(State.pendingApproval ? State.pendingReviewView : State.defaultView());
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onFileDragActive(active: boolean) {
    State.fileDragActive = active;
    this.updateFileApproach();
    if (active && this.fileDragNear()) this.showFileDrop();
    else if (!active && !State.fileDragOver) this.cancelFileDrag();
    State.notify();
  }

  /** Win32 cursor samples already use window-logical pixels at the current DPI. */
  private fileDragDistance(): number {
    const rect = this.islandRect(), { x, y } = State.mouse;
    const dx = Math.max(rect.x - x, 0, x - rect.x - rect.w);
    const dy = Math.max(rect.y - y, 0, y - rect.y - rect.h);
    return Math.hypot(dx, dy);
  }

  private fileDragNear(): boolean { return this.fileDragDistance() <= FILE_DRAG_MARGIN; }

  private updateFileApproach(): void {
    const approaching = State.fileDragActive && !this.fileDragOrigin && State.visibility !== "peek"
      && !State.paused && !State.pendingApproval && !Activity.voice.active
      && this.fileDragDistance() <= FILE_APPROACH_MARGIN;
    if (approaching && !this.fileApproaching) this.engine.triggerExpression("surprised", .6);
    this.fileApproaching = approaching;
    this.botCanvas.dataset.fileApproach = String(approaching);
  }

  private showFileDrop() {
    if (Activity.voice.active) return;
    if (State.pendingApproval || State.paused || State.view === "uploading" || State.chatAttachmentLoading) return;
    if (!this.fileDragOrigin) this.fileDragOrigin = { view: State.view, visibility: State.visibility };
    if (State.view !== "upload") {
      this.uploadCanvas.syncIntegrations();
      this.engine.animateMorph(1);
      UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
      // Dragging is an explicit action, including from peek and when automatic expansion is off.
      this.open("upload");
    }
  }

  private cancelFileDrag() {
    if (!this.fileDragOrigin || State.view !== "upload") return;
    const origin = this.fileDragOrigin;
    this.fileDragOrigin = null;
    UploadSeq.deactivate();
    this.engine.animateMorph(0);
    this.setView(origin.view);
    if (origin.visibility === "peek") Visibility.peek();
    else if (origin.visibility === "island") Visibility.island();
  }

  private onDragDrop(e: { type: string; paths?: string[] }, targeted = false) {
    if (Activity.voice.active) return;
    if (e.type !== "over")
      void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused || State.pendingApproval) return;
    if (State.view === "uploading" || State.chatAttachmentLoading) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (!this.fileDragNear()) return;
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.showFileDrop();
        State.notify();
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        if (!State.fileDragActive) this.cancelFileDrag();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        // Detached Grab's explicit target already owns its drop; desktop drags must be close.
        if (!targeted && !this.fileDragNear()) {
          this.cancelFileDrag();
          State.notify();
          return;
        }
        if (!e.paths?.length || e.paths.length + State.droppedFiles.length > MAX_CHAT_FILES) {
          State.chatError = `You can attach up to ${MAX_CHAT_FILES} files. Remove a file before adding more.`;
          this.fileDragOrigin = null;
          UploadSeq.deactivate();
          this.engine.animateMorph(0);
          this.open("prompt");
          return;
        }
        this.uploadCanvas.syncIntegrations();
        if (!UploadSeq.isActive) UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.swallow(e.paths);
        break;
      }
    }
  }

  /**
   * Mimo eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(paths: string[]) {
    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;
    this.uploadGulped = false;

    this.engine.gulp();
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void attachChatFiles(paths, () => !this.disposed).then((attached) => {
      if (!attached && !this.disposed && State.chatError && UPLOAD_VIEWS.has(State.view)) {
        UploadSeq.deactivate();
        this.fileDragOrigin = null;
        this.engine.animateMorph(0);
        this.setView("prompt");
        Sound.play("error");
      }
    });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * a completion chime, then a retained choice once Mimo grows back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    if (!this.uploadGulped && since >= USC.T_SUCK_END - USC.T_DROP) {
      this.uploadGulped = true;
      Sound.play("gulp");
    }
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur && !State.chatAttachmentLoading && State.droppedFiles.length) {
      this.uploadDone = true;
      Sound.play("finish");
      this.engine.triggerEmote("happy");
    }
    // Wait for both the animation and copy, then let the user choose when to ask.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading" && !State.chatAttachmentLoading && State.droppedFiles.length) {
      this.fileDragOrigin = null;
      State.fileDragOver = false;
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private get shellTop(): number {
    return this.positionY.value;
  }

  private showQuickMenu(x: number, y: number): void {
    if (IS_TAURI) {
      Visibility.setDragging(true);
      void Bridge.showMimoMenu().finally(() => { if (!this.disposed) Visibility.setDragging(false); });
      return;
    }
    this.quickMenu ??= new MimoQuickMenu(id => {
      if (id === "dock") { this.resetPosition(); return; }
      if (id === "settings") { void Bridge.openSettingsWindow(); return; }
      const fields = {working:"workingModeEnabled",sound:"soundEnabled",usage:"usageEnabled",clock:"clockEnabled"} as const;
      const field = fields[id as keyof typeof fields];
      if (!field) return;
      State.settings[field] = !State.settings[field];
      this.applySettings(); this.animateGeometry(false); State.notify();
      void Bridge.saveSettings(State.settings);
    }, open => Visibility.setDragging(open));
    this.quickMenu.open([
      {id:"dock",label:"Return to top"},
      {id:"working",label:"Working mode",checked:State.settings.workingModeEnabled},
      {id:"sound",label:"Sound",checked:State.settings.soundEnabled},
      {id:"usage",label:"Limits",checked:State.settings.usageEnabled},
      {id:"clock",label:"Island clock",checked:State.settings.clockEnabled},
      {id:"settings",label:"Settings…"},
    ],x,y,this.restoreTarget.hidden ? this.patTarget : this.restoreTarget);
  }

  private targetSize(): { w: number; h: number; r: number } {
    if (State.visibility === "expanded" && this.coreMode === "hover")
      return { w: MEDIA_HOVER_W, h: MEDIA_HOVER_H, r: 24 };
    const { w, h } = islandSize(
      State.visibility,
      State.view,
      State.chatHistory.length,
    );
    const layout = this.views.get(State.view)?.layout?.();
    const r =
      State.visibility === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    const bodyHeight =
      State.visibility === "expanded" ? (layout?.height ?? h) : h;
    const reserve = this.views.get(State.view)?.layout
      ? 0
      : this.media.heightFor(State.visibility, State.view);
    return {
      w: (State.visibility === "island" && this.media.available &&
        (mediaStore.snapshot().state.playbackState === "paused" || this.compactControlsHeld) ? 288 : w)
        +(State.visibility === "island"&&this.grabReturnHover?16:0),
      h: Math.min(PANEL_H, bodyHeight + reserve+(State.visibility === "island"&&this.grabReturnHover?6:0)),
      r: State.visibility === "peek" ? PEEK_H/2 : State.visibility === "island" ? 20 : r,
    };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    this.geometryHeight = h;
    if (State.visibility === "expanded") this.contentEl.style.height = `${h}px`;
    const mediaHeight = this.views.get(State.view)?.layout
      ? 0
      : this.media.heightFor(State.visibility, State.view);
    this.updatePositionMotion();
    if (this.reducedMotion) {
      this.width.jump(w);
      this.height.jump(h);
      this.mediaSpace.jump(mediaHeight);
      this.radius.jump(r);
    } else if (shrinking) {
      const closing = State.visibility !== "expanded";
      this.width.curveTowards(w, closing ? 320 : 220);
      this.height.curveTowards(h, closing ? 320 : 220);
      this.mediaSpace.curveTowards(mediaHeight, closing ? 320 : 340);
      this.radius.curveTowards(r, closing ? 320 : 220);
    } else {
      const response = State.visibility === "island" || this.coreMode ? 0.3 : 0.42;
      this.width.springTo(w, response, 1);
      this.height.springTo(h, response, 1);
      this.mediaSpace.springTo(mediaHeight, response, 1);
      this.radius.springTo(r, response, 1);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = Math.min(PANEL_H, this.height.value);
    const r = this.radius.value;
    const center = this.horizontalCenter();
    const top = this.shellTop;
    const geometryKey = `${w}/${hh}/${r}/${this.mediaSpace.value}/${center}/${top}`;
    if (geometryKey !== this.appliedGeometry) {
      this.appliedGeometry = geometryKey;
      this.islandEl.style.width = `${w}px`;
      this.islandEl.style.height = `${hh}px`;
      this.islandEl.style.left = `${center}px`;
      this.islandEl.style.top = `${top}px`;
      this.contentEl.style.paddingBottom = `${10 + this.mediaSpace.value}px`;
      this.islandEl.style.setProperty("--compact-crop", "0px");
      this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
      const edge = 8,
        corner = Math.min(r, hh / 2);
      const outline = `M0 0 H${w} Q${w - 2} 0 ${w - 4} 3 L${w - 6} 5 Q${w - edge} 7 ${w - edge} 11 V${Math.max(11, hh - corner)} Q${w - edge} ${hh} ${w - edge - corner} ${hh} H${edge + corner} Q${edge} ${hh} ${edge} ${Math.max(11, hh - corner)} V11 Q${edge} 7 6 5 L4 3 Q2 0 0 0 Z`;
      this.islandEl.style.setProperty(
        "--notch-shape",
        `path("${outline}")`,
      );
      this.coreRimPath.setAttribute("d", outline);
      this.islandEl.style.transform = `translateX(-50%)`;
      // These follow the island as it resizes, so they belong here rather than in
      // the state-driven DOM sync.
      this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
      this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;
    }

    let rect = this.islandRect();
    const p = this.pushedRect;
    if (
      Math.abs(p.x - rect.x) > 0.5 ||
      Math.abs(p.y - rect.y) > 0.5 ||
      Math.abs(p.w - rect.w) > 0.5 ||
      Math.abs(p.h - rect.h) > 0.5 ||
      Math.abs(p.r - r) > 0.5
    ) {
      this.pushedRect = { ...rect, r };
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h, r);
    }
  }

  /** Island rect relative to the current native window. */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = Math.min(PANEL_H, this.height.value);
    return {
      x: this.horizontalCenter() - w / 2,
      y: this.shellTop,
      w,
      h: hh,
    };
  }

  /** Opening grows around the saved top anchor and makes room at either end. */
  private horizontalCenter(): number {
    return this.positionX.value;
  }

  private updatePositionMotion(): void {
    const center = window.innerWidth / 2;
    if (this.reducedMotion) { this.positionX.jump(center); this.positionY.jump(0); }
    else { this.positionX.springTo(center, .28, 1); this.positionY.springTo(0, .28, 1); }
  }

  setPosition(position: IslandPositionInfo): void {
    if (this.disposed || !Number.isFinite(position.anchorX)) return;
    State.settings.desktopCompanion = null;
    State.settings.islandAnchor = null;
    this.dirty = true;
    this.animateGeometry(false);
  }

  resetPosition(): void {
    void Bridge.resetIslandPosition().then(position => {
      if (this.disposed) return;
      this.setPosition(position ?? { anchorX: window.innerWidth / 2, anchorY: 0, ratio: null });
      Visibility.island();
    });
  }

  private wireInput() {
    document.addEventListener("keydown",event=>{
      if(event.key==="Control")this.setGrabModifier(true);
      if(event.key==="Escape"&&this.grabDetached){
        event.preventDefault();void Bridge.grabAction("dock").catch(error=>this.grabFailed(error));
      }
    },{signal:this.lifetime.signal});
    document.addEventListener("keyup",event=>{if(event.key==="Control")this.setGrabModifier(false);},{signal:this.lifetime.signal});

    const pointerOptions = { signal: this.lifetime.signal };
    this.islandEl.addEventListener("contextmenu", event => {
      event.preventDefault(); this.showQuickMenu(event.clientX,event.clientY);
    }, pointerOptions);
    this.islandEl.addEventListener("mousedown", () => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.visibility !== "expanded") return;
      if (this.hoverExpanded) {
        this.hoverExpanded = false;
        this.dirty = true;
        this.ensureRunning();
      }
    });

    window.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase();
      if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) &&
        this.islandEl.contains(document.activeElement)) {
        e.preventDefault(); const rect=this.islandEl.getBoundingClientRect(); this.showQuickMenu(rect.x+rect.width/2,rect.bottom); return;
      }
      const editable = e.target instanceof Element &&
        e.target.closest("input,textarea,select,[contenteditable=true]");
      if (key === "home" && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && !e.repeat && !editable) {
        e.preventDefault();
        this.resetPosition();
      }
      // A background request never takes focus or accepts another app's typing.
      // The visible shortcuts become active after the user clicks the island.
      if (State.view === "approval" && State.visibility === "expanded" &&
        !this.hoverExpanded && State.pendingApproval && !editable &&
        !e.defaultPrevented && !e.repeat && !e.isComposing &&
        !e.ctrlKey && !e.metaKey && !e.altKey && (key === "y" || key === "n")) {
        e.preventDefault();
        this.decideApproval(key === "y" ? "allow" : "deny");
      }
      if (e.key === "Escape" && !e.defaultPrevented && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    }, { signal: this.lifetime.signal });
    window.addEventListener("blur", () => {
        this.workShortcutActive = false;
      // Native focus changes also occur during click-through and activation.
      // The desktop cursor poll, rather than focus, owns pointer leave there.
      if (!IS_TAURI) this.onCursor(-10_000, -10_000);
      Visibility.focusLost();
    }, { signal: this.lifetime.signal });
    document.addEventListener("pointerdown", (event) => {
      if (!this.islandEl.contains(event.target as Node))
        Visibility.outsideClick();
    }, { signal: this.lifetime.signal });
    window.addEventListener("resize", () => {
      this.dirty = true;
      this.ensureRunning();
    }, { signal: this.lifetime.signal });

    void onDragDrop((e) => {
      if (!this.disposed) this.onDragDrop(e);
    }).then(stop => this.lifetime.own(stop));
    void onEvent<boolean>("file-drag-active", active => {
      if (!this.disposed) this.onFileDragActive(active);
    }).then(stop => this.lifetime.own(stop));

    document.addEventListener("visibilitychange", () => {
      pauseMiniBotAnimations(document.hidden);
      this.overview.setDocumentHidden(document.hidden);
      if (document.hidden) {
        if (Activity.voice.active) this.closeDesktopVoice();
        for (const view of this.views.values()) view.setVisible?.(false);
        if (this.raf !== undefined) cancelAnimationFrame(this.raf);
        this.raf = undefined;
        this.running = false;
        clearTimeout(this.ambientTimer);
        this.ambientTimer = undefined;
      } else {
        this.dirty = true;
        this.ensureRunning();
      }
    }, { signal: this.lifetime.signal });

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used by browser previews without the native cursor poll: the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) =>
      this.onCursor(e.clientX, e.clientY,{x:e.clientX,y:e.clientY,control:e.ctrlKey}),
      { signal: this.lifetime.signal },
    );
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    }, { signal: this.lifetime.signal });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number, sample?: CursorSample) {
    if (this.disposed || document.hidden) return;
    if(sample?.control!==undefined)this.setGrabModifier(sample.control);
    // The native window stays centered as its width changes. A stationary
    // desktop pointer must not become a fresh hover because its local x changes.
    if (sample?.windowWidth && Number.isFinite(sample.windowWidth))
      x += (window.innerWidth - sample.windowWidth) / 2;
    if(IS_TAURI&&sample?.down&&this.grabDrag)this.beginGrabDrag(x,y);
    if(IS_TAURI&&sample?.down===false&&!this.grabDrag?.dragged)this.grabDrag=null;
    const desktop = Number.isFinite(sample?.screenX) && Number.isFinite(sample?.screenY);
    const cursor = desktop ? { x: sample!.screenX!, y: sample!.screenY! }
      : { x: x - window.innerWidth / 2, y };
    const cursorKnown = Number.isFinite(x) && Number.isFinite(y) && x > -9000 && y > -9000;
    const moved = cursorKnown && (this.cursorPosition === null ||
      (this.cursorDesktop === desktop &&
        Math.hypot(cursor.x - this.cursorPosition.x, cursor.y - this.cursorPosition.y) > 0.5));
    if (cursorKnown) {
      this.cursorPosition = cursor;
      this.cursorDesktop = desktop;
    }
    if (this.homeReturnHeld && moved) {
      this.homeReturnHeld = false;
      State.notify();
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // A desktop drag is only intent to feed Mimo once it approaches the visible island.
    this.updateFileApproach();
    if (State.fileDragActive && !this.fileDragOrigin && this.fileDragNear()) this.showFileDrop();

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const margin = State.visibility === "peek" ? 0 : HIT_MARGIN;
    const inIsland = State.fileDragActive ? this.fileDragNear()
      : x >= rect.x - margin && x < rect.x + rect.w + margin &&
        y >= rect.y - margin && y < rect.y + rect.h + margin;
    // Native desktop movement counts as activity even outside the narrow island.
    if (moved && Number.isFinite(x) && Number.isFinite(y) && !(x <= -9000 && y <= -9000))
      State.lastActivity = performance.now();

    if (State.visibility === "peek") {
      if (inIsland && !this.wasInIsland) Visibility.pointerEntered(true);
      if (!inIsland && this.wasInIsland) Visibility.pointerLeft();
      this.wasInIsland = inIsland;
      return;
    }
    const overReview = State.visibility === "island" && this.activity.reviewHit(x, y, HIT_MARGIN);
    const overControls = State.visibility === "island" &&
      this.media.compactControlHit(x, y, HIT_MARGIN);
    const holdControls = this.grabModifier || this.activity.clickOnly || overReview || overControls &&
      (this.compactControlsHeld ||
        mediaStore.snapshot().state.playbackState === "paused");
    if (inIsland && (!this.wasInIsland || this.compactControlsHeld)) {
      if (State.view === "greeting") this.greeting.hover();
      this.holdCompactControls(holdControls);
      if (!holdControls && State.visibility !== "expanded") {
        this.hoverExpanded = true;
        // Follow the visible island state, including coding while music plays.
        // The minimized Working mode lip is handled separately above.
        if (this.activity.el.dataset.kind === "coding" && !ownsContent(State.view)) {
          this.greetingPending = false;
          this.expand("overview", true);
        } else if (this.media.available &&
          ["playing", "paused"].includes(mediaStore.snapshot().state.playbackState) &&
          !ownsContent(State.view)) {
          this.greetingPending = false;
          this.coreMode = "hover";
        }
      }
      Visibility.pointerEntered(holdControls);
      if (!holdControls) this.startGreetingOnHover();
    }
    if (!inIsland && this.wasInIsland) {
      this.leaveIsland();
    }
    this.wasInIsland = inIsland;

    // A pass starts on entry, then another distinct stroke requires travel and
    // reversal. Native cursor ticks and small pointer jitter cannot add pats.
    const overBot =
      State.visibility === "expanded" &&
      State.stateOverride == null &&
      this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const dx = x - this.botHoverStart.x, dy = y - this.botHoverStart.y;
      const distance = Math.hypot(dx, dy);
      const direction = this.hoverPatDirection;
      if (distance >= 16 && performance.now() - this.lastHoverPat >= 180
        && (!direction || (dx * direction.x + dy * direction.y) / distance < -.15)) {
        this.hoverPatDirection = { x: dx / distance, y: dy / distance };
        this.hoverPat(x, y);
      }
    }

    if (moved) this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    if (this.patTarget.hidden || this.patTarget.disabled) return false;
    const rect = this.patTarget.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private botHoverIn(x: number, y: number) {
    this.hoverPatDirection = null;
    this.hoverPat(x, y);
  }

  private hoverPat(x: number, y: number) {
    this.botHoverStart = { x, y }; this.lastHoverPat = performance.now();
    if (performance.now() / 1000 - this.lastLoveTime < 4) return;
    if (this.engine.pat()) this.lastLoveTime = performance.now() / 1000;
  }

  private cancelBotHover() {
    this.hoverPatDirection = null;
  }

  /** Three pokes → a friendly three-second pause, then the current work. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused", true);
    if (this.confusedRecovery != null)
      window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      if (State.stateOverride === "dizzy") State.stateOverride = null;
      this.engine.setState(
        State.effectiveState,
      );
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(
          this.prevViewBeforeConfused === "confused"
            ? fallback
            : this.prevViewBeforeConfused,
        );
      }
      this.engine.triggerEmote("happy");
    }, 3000);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.disposed || document.hidden) return;
    clearTimeout(this.ambientTimer);
    this.ambientTimer = undefined;
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    this.raf = undefined;
    if (this.disposed) {
      this.running = false;
      return;
    }
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.mediaSpace.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.positionX.step(dt,nowMs);
    this.positionY.step(dt,nowMs);

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);
    this.applyGeometry();
    if(this.grabReturning&&nowMs-this.grabGeometrySentAt>=32)this.publishGrabReturnGeometry();

    const greetingActive =
      State.visibility === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const dpr = resizeCanvas(this.greetingCanvas, EXPANDED_W, 150);
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mimo
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.uploadCanvas.el.inert = !uploadActive;
    this.viewsEl.inert = uploadActive;
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // The minimized lip has no mascot animation; only its shell needs to settle.
    const settling =
      this.width.animating ||
      this.height.animating ||
      this.radius.animating ||
      this.mediaSpace.animating || this.positionX.animating || this.positionY.animating;
    const hint = settling ? "width, height, transform" : "";
    if (this.islandEl.style.willChange !== hint) this.islandEl.style.willChange = hint;
    const busy = this.dirty || (
      State.visibility === "peek"
        ? settling ||
          this.engine.changingOrientation ||
          !this.botCx.settled ||
          !this.botCy.settled ||
          !this.botSize.settled
        : settling ||
          !this.botCx.settled ||
          !this.botCy.settled ||
          !this.botSize.settled ||
          greetingActive ||
          (this.mascotVisible && this.engine.busy) ||
          miniBotsBusy() ||
          UploadSeq.animating);

    if (busy) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
      // The minimized lip does not run an ambient Canvas loop.
      if (State.visibility !== "peek") {
        const delay = Math.min(this.mascotVisible ? this.engine.nextWakeDelayMs : Infinity, nextMiniBotWakeDelayMs());
        if (Number.isFinite(delay)) this.ambientTimer = setTimeout(() => this.ensureRunning(), delay);
      }
    }
  };

  private updateBotTargets() {
    let p = botPosition(
      State.visibility,
      State.view,
      this.height.value - this.mediaSpace.value,
      State.uploadProgress,
    );
    const layout = this.views.get(State.view)?.layout?.();
    if (State.visibility === "expanded" && layout) {
      p = {
        cx: layout.botX,
        cy: layout.botY ?? p.cy,
        diameter: layout.botDiameter,
        opacity: layout.botDiameter > 0 ? 1 : 0,
      };
    }
    if (this.coreMode) p = { cx: 34, cy: 24, diameter: 30, opacity: 0 };
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;
    const app = State.visibility === "expanded" && !this.coreMode;
    const response = app ? 0.42 : 0.3;
    const damping = 1;
    this.botCx.configure(response, damping);
    this.botCy.configure(response, damping);
    this.botSize.configure(response, damping);

    const greetingActive =
      State.visibility === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mimo; two of them would overlap.
    const visible = p.diameter > 0 && p.opacity > 0 && !greetingActive && !this.uploadActive && !this.grabDetached;
    this.mascotVisible = visible && (this.grabModifier || State.visibility !== "island" || this.activity.el.dataset.kind !== "music");
    const opacity = this.mascotVisible ? "1" : "0";
    if (this.botCanvas.style.opacity !== opacity) this.botCanvas.style.opacity = opacity;
    const hidden = String(!this.mascotVisible);
    if (this.botCanvas.getAttribute("aria-hidden") !== hidden) this.botCanvas.setAttribute("aria-hidden", hidden);
    const patSize = Math.max(44, Math.min(80, this.botSize.value));
    const size = `${Math.round(patSize * 1000) / 1000}px`;
    const left = `${Math.round((this.botCx.value - patSize / 2) * 1000) / 1000}px`;
    const top = `${Math.round((this.botCy.value - patSize / 2) * 1000) / 1000}px`;
    if (this.patTarget.style.width !== size) this.patTarget.style.width = size;
    if (this.patTarget.style.height !== size) this.patTarget.style.height = size;
    if (this.patTarget.style.left !== left) this.patTarget.style.left = left;
    if (this.patTarget.style.top !== top) this.patTarget.style.top = top;
    const patHidden = !this.grabDrag?.dragged && (!this.mascotVisible || State.visibility === "island"&&!this.grabModifier || this.coreMode !== null);
    if (this.patTarget.hidden !== patHidden) this.patTarget.hidden = patHidden;

  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, size);
    const hCss = w + BOT_OVERHANG;
    const frameHeight = BOT_CANVAS_EDGE + BOT_OVERHANG;
    const dpr = resizeCanvas(this.botCanvas, BOT_CANVAS_EDGE, frameHeight);
    const left = `${Math.round((this.botCx.value - BOT_CANVAS_EDGE / 2) * 1000) / 1000}px`;
    const top = `${Math.round((this.botCy.value - BOT_OVERHANG / 2 - frameHeight / 2) * 1000) / 1000}px`;
    if (this.botCanvas.style.left !== left) this.botCanvas.style.left = left;
    if (this.botCanvas.style.top !== top) this.botCanvas.style.top = top;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const integration = State.visibility === "expanded" && State.view === "overview"
      ? this.overview.companionTask : State.visibility === "island" && this.activity.el.dataset.kind === "coding"
        ? this.activity.codingTask : null;
    const focused = integration;
    const info = focused ? State.integrations[focused.id] : undefined;
    const musicPlaying = musicPerformanceActive({ view: State.view,
      expanded: State.visibility === "expanded" && this.coreMode === null,
      enabled: State.settings.modules.media, playing: mediaStore.snapshot().state.playbackState === "playing" });
    const voicePhase = Activity.voice.phase;
    const voiceVisible = State.view === "voice";
    const state = voiceVisible ? voicePhase === "error" ? "error" : ["connecting", "transcribing", "waiting"].includes(voicePhase) ? "thinking" : "idle" : companionStateForView({ view: integration && State.visibility === "island" ? "overview" : State.view, override: State.stateOverride,
      integrationState: integration?.activity?.phase === "failed" ? "error" : integration?.state,
      integrationCompleted: !!integration?.activity?.completed && !integration.activity.stopped,
      pendingApproval: State.view === "approval" || State.pendingApprovals.some(request => request.taskId === integration?.id && !request.questions), mediaError: mediaStore.snapshot().state.providerStatus === "error" });
    this.engine.tile = false;
    this.engine.backdrop = State.view !== "media";
    this.engine.voiceMode = voiceVisible && voicePhase !== "error" ? voicePhase === "recording" ? "listening" : voicePhase === "speaking" ? "speaking" : voicePhase === "idle" || voicePhase === "paused" ? "ready" : "waiting" : null;
    this.engine.showBadge = State.visibility !== "peek";
    this.engine.badgeMode = "contextual";
    this.engine.setIntegration(integration?.id ?? null);
    this.engine.allowWorkPokes = true;
    const spotifyPlaying = musicPlaying && /spotify/i.test(mediaStore.snapshot().state.sourceAppId ?? "");
    const colorHex = voiceVisible ? null : State.view === "media" ? spotifyPlaying ? MIMO_PALETTE.connected : null
      : State.stateOverride === "dizzy" ? this.companionColorHex
      : integration && !codingProvider(integration)
        ? MIMO_PICKER_COLORS[integration.id] ?? MIMO_APPS[integration.id]?.color ?? integration.color : null;
    if (colorHex !== this.companionColorHex) {
      this.companionColorHex = colorHex;
      this.companionColor = colorHex ? hexToRGB(colorHex) : null;
    }
    this.engine.bodyColor = this.companionColor;
    this.botCanvas.dataset.color=this.companionColorHex??"";
    this.engine.setState(state);
    this.engine.setStatus(mimoAppStatus(this.engine.state, info, focused?.id));
    this.engine.setExpressionContext(expressionForContext({
      editing: State.visibility === "expanded" && !!document.activeElement
        && this.islandEl.contains(document.activeElement)
        && document.activeElement.matches('textarea:not([readonly]):not([disabled]), input:not([type="range"]):not([type="checkbox"]):not([type="button"]):not([readonly]):not([disabled]), [contenteditable="true"]'),
      focusedFile: !!integration && !!codingProvider(integration) && integration.activity?.phase === "running"
        && ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"].includes(integration.activity.tool),
      emptyResult: State.view === "result" && !!State.searchResult && State.searchResult.items.length === 0,
      missedApproval: State.missedApprovalCount > 0 && (State.view === "overview" || State.view === "approvals"),
      playing: musicPlaying,
      power: State.view === "overview" ? State.power : null,
    }));
    const patDisabled = !this.engine.canPoke && !this.grabModifier;
    if (this.patTarget.disabled !== patDisabled) this.patTarget.disabled = patDisabled;
    if (this.botCanvas.dataset.status !== this.engine.status || this.botCanvas.dataset.expression !== this.engine.currentExpression) {
      this.botCanvas.dataset.status = this.engine.status;
      this.botCanvas.dataset.expression = this.engine.currentExpression;
      this.botCanvas.setAttribute("aria-label", `Mimo companion, ${MIMO_EXPRESSIONS[this.engine.currentExpression].label.toLowerCase()}`);
    }
    this.engine.particleOverhang = BOT_OVERHANG;
    const rect = this.islandRect();
    const gaze = mimoCursorGaze(State.mouse.x, State.mouse.y,
      rect.x + this.botCx.value, rect.y + this.botCy.value);
    this.engine.lookX = gaze.x;
    this.engine.lookY = gaze.y;
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, BOT_CANVAS_EDGE, frameHeight);
    ctx.translate((BOT_CANVAS_EDGE - w) / 2, (frameHeight - hCss) / 2);
    this.engine.draw(ctx, w, hCss);
  }

  private updateCountdown(nowMs: number) {
    if (
      State.visibility !== "expanded" ||
      State.isPinned ||
      Visibility.deadline == null
    ) {
      if (this.countdown.style.width !== "0px") this.countdown.style.width = "0px";
      return;
    }
    const windowS = ACTIVITY_SETTLE_MS / 1000 * 0.6;
    const remaining = (Visibility.deadline - nowMs) / 1000;
    const width =
      remaining < windowS
        ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px`
        : "0px";
    if (this.countdown.style.width !== width) this.countdown.style.width = width;
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    this.uploadCanvas.syncIntegrations();
    this.uploadCanvas.setVisible(this.uploadActive);
    if (Activity.voice.active) this.views.get("prompt")?.sync();
    this.activity.sync(this.compactControlsHeld);
    this.activity.el.hidden=this.grabModifier||this.grabDetached;
    this.media.place(this.contentEl, State.view);
    this.media.sync(State.visibility, State.view, true, this.coreMode,
      this.grabModifier || State.visibility === "island" && ["coding", "notice"].includes(this.activity.el.dataset.kind ?? ""));
    const expanded = State.visibility === "expanded";
    const greetingActive = expanded && State.view === "greeting";
    const appExpanded = expanded && !this.coreMode;
    this.islandEl.dataset.core = this.coreMode ?? (expanded ? "app" : State.visibility);

    this.contentEl.style.opacity = appExpanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents =
      appExpanded && !greetingActive && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = appExpanded && !greetingActive ? "auto" : "none";
    this.contentEl.inert = !appExpanded || greetingActive;
    this.islandEl.dataset.visibility = State.visibility;
    this.islandEl.dataset.view = State.view;
    this.islandEl.dataset.workingMode = String(State.settings.workingModeEnabled);
    this.islandEl.dataset.minimized = String(State.visibility === "peek");
    this.islandEl.dataset.mascot =
      (this.views.get(State.view)?.layout?.() ?? VIEW_LAYOUTS[State.view]).botDiameter === 18
        ? "header"
        : "activity";
    this.restoreTarget.hidden = expanded && this.coreMode !== "hover";
    this.restoreTarget.setAttribute(
      "aria-label",
      State.visibility === "peek" ? "Click to open Mimo. Working mode keeps browser tabs clear."
        : this.media.available && !ownsContent(State.view) ? "Open Media" : "Open Mimo",
    );
    this.islandEl.dataset.compact = String(Visibility.compact);
    Visibility.setProtected(
      expanded &&
        (this.homeReturnHeld || this.workShortcutActive || ownsContent(State.view) ||
          (this.islandEl.contains(document.activeElement) &&
            document.activeElement?.matches(
              "textarea,input:not([type=range])",
            )) ||
          State.fileDragOver),
    );
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view && appExpanded;
      view.el.classList.toggle("on", on);
      view.el.inert = !on || !expanded;
      view.setVisible?.(on && expanded && !document.hidden);
      if (on) view.sync();
    }
    // A retained view can change height after measuring or a user expands its preview.
    const contentHeight = this.targetSize().h;
    if (appExpanded && contentHeight !== this.geometryHeight)
      this.animateGeometry(contentHeight < this.geometryHeight);

    // Hover can reveal the full tool without taking focus from the user's app.
    // A click, keyboard activation or explicit navigation enables Media focus.
    const keyboardActive = appExpanded && !this.hoverExpanded &&
      (this.homeReturnHeld || this.workShortcutActive || State.view === "voice" || State.view === "prompt" || State.view === "media" || State.view === "usage" || State.view === "grab" ||
        State.view === "overview" && this.overview.el.dataset.preview === "true" ||
        ["approval", "approvals"].includes(State.view));
    if (keyboardActive !== this.keyboardActive) {
      this.keyboardActive = keyboardActive;
      void Bridge.focusWindow(keyboardActive);
    }
    if (this.lastSyncedView !== State.view) {
      this.engine.clearExpressionReaction();
      this.cancelBotHover(); this.botHovering = false;
      this.lastSyncedView = State.view;
      if (State.view === "prompt")
        this.lifetime.after(() => {
          if (State.view === "prompt" && State.visibility === "expanded")
            this.views.get("prompt")?.focus?.();
        }, 120);
    }

    pruneMiniBots();
    syncMiniBotStates(State.tasks);
    this.engine.setState(
      State.effectiveState,
    );
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    if(!State.settings.grabEnabled){this.setGrabModifier(false);if(!this.grabDrag?.dragged)this.grabDrag=null;}
    applyAppearance(State.settings.appearance);
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    Visibility.configure(State.settings);
    Visibility.setWorking(this.codingWorkActive);
    this.media.setEnabled(State.settings.modules.media);
    if (!State.settings.modules.media) this.coreMode = null;
    if (
      State.settings.modules.media &&
      this.media.ambientEl.parentElement !== this.clipEl
    )
      this.clipEl.append(this.media.ambientEl);
    State.view = safeSectionView(
      State.view,
      State.settings.modules,
      State.settings.activeIntegrations.length,
      State.settings.usageEnabled,
      Object.values(codingConnections(State.settings, State.tasks)).some(Boolean),
    );
    this.overview.sync();
    this.animateGeometry(false);
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
