// SPDX-License-Identifier: MIT
// Installs the release build on this PC: stops Kumo, copies kumo.exe and the hook relay into
// %LOCALAPPDATA%\Programs\Kumo, starts Kumo again. `npm run install:local` builds first.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const source = join(import.meta.dirname, "..", "target", "release");
const target = join(process.env.LOCALAPPDATA, "Programs", "Kumo");
const files = ["kumo.exe", "kumo-hook.exe"];
for (const file of files)
  if (!existsSync(join(source, file))) throw new Error(`${file} is missing in ${source}. Build first.`);
mkdirSync(target, { recursive: true });

try { execFileSync("taskkill", ["/IM", "kumo.exe", "/F"], { stdio: "ignore" }); } catch { /* not running */ }
// A coding agent's hook can still be running the relay; wait for both files to be released.
for (const file of files) {
  for (let attempt = 1; ; attempt++) {
    try { copyFileSync(join(source, file), join(target, file)); break; }
    catch (error) {
      if (attempt >= 10) throw new Error(`Could not replace ${file} (still in use?): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
spawn(join(target, "kumo.exe"), [], { detached: true, stdio: "ignore" }).unref();
console.log(`Installed to ${target} and started Kumo.`);
