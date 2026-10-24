// SPDX-License-Identifier: MIT
// "Send to phone" (LocalSend, localsend.rs): the compact strip shows Phone · Sending… / Sent / why it failed.
import { onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const TASK = "agent_phone";
let clear: number | undefined;

type PhoneEvent = { t: "sending"; device: string } | { t: "sent"; device: string; files: number } | { t: "failed"; error: string };

function show(island: Island, state: "working" | "finished" | "error", text: string, linger: number) {
  State.upsertExternalAgent(TASK, "Phone", "#f67e7d");
  const task = State.tasks.find(t => t.id === TASK)!;
  task.state = state === "finished" ? "idle" : state;
  task.statusText = text;
  task.pillBadge = state === "finished" ? "finished" : state === "error" ? "error" : null;
  State.notify();
  island.reveal();
  window.clearTimeout(clear);
  if (linger) clear = window.setTimeout(() => State.removeTask(TASK), linger);
}

export async function registerPhoneHandlers(island: Island): Promise<() => void> {
  const stop = await onEvent<PhoneEvent>("localsend", event => {
    if (event.t === "sending") show(island, "working", `Sending to ${event.device}… accept it there`, 0);
    else if (event.t === "sent") { Sound.play("approve"); show(island, "finished", `Sent to ${event.device}`, 6000); }
    else { Sound.play("error"); show(island, "error", event.error, 10000); }
  });
  return () => { stop(); window.clearTimeout(clear); };
}
