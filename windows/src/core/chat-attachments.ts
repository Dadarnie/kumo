// SPDX-License-Identifier: MIT
import { Bridge } from "./bridge";
import { State } from "./state";

export const MAX_CHAT_FILES = 5;

/** Publish a complete batch only after copying, and only for its conversation. */
export async function attachChatFiles(paths: string[], alive = () => true): Promise<boolean> {
  const previous = State.droppedFiles.map(file => ({ ...file }));
  if (!paths.length || paths.length + previous.length > MAX_CHAT_FILES) {
    State.chatError = `You can attach up to ${MAX_CHAT_FILES} files. Remove a file before adding more.`;
    State.notify();
    return false;
  }
  State.chatAttachmentVersion++;
  State.promptContext = null;
  const version = State.chatAttachmentVersion;
  const epoch = State.chatEpoch;
  const owned = () => version === State.chatAttachmentVersion && epoch === State.chatEpoch;
  const current = () => alive() && owned();
  State.chatAttachmentLoading = paths.length > 1 ? `${paths.length} files` : paths[0].split(/[\\/]/).pop() || "file";
  State.chatError = "";
  State.notify();
  try {
    // Copy in order so repeated names cannot race for the same inbox filename.
    const files = [];
    for (const path of paths) {
      const file = await Bridge.ingestFile(path);
      if (!current()) return false;
      files.push({ name: file.name, path: file.path });
    }
    if (!current()) return false;
    State.droppedFiles = [...previous, ...files];
    State.promptContext = State.droppedFiles.length === 1 ? { kind: "file", ...State.droppedFiles[0] } : { kind: "files", files: State.droppedFiles };
    return true;
  } catch (error) {
    if (current()) State.chatError = String(error).replace(/^Error:\s*/, "");
    return false;
  } finally {
    if (owned()) {
      State.chatAttachmentLoading = null;
      State.notify();
    }
  }
}
