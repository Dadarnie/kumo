// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

// Compile only the modules exercised by Node tests, using the existing compiler.
const sourceRoot = new URL("../src/", import.meta.url);
const outputRoot = new URL(`../target/frontend-tests/${process.pid}/`, import.meta.url);
const modules = new Map();
export async function loadSource(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  if (modules.has(sourceUrl.href)) return modules.get(sourceUrl.href);
  assert.ok(sourceUrl.href.startsWith(sourceRoot.href));
  const outputUrl = new URL(
    sourceUrl.href.slice(sourceRoot.href.length).replace(/\.ts$/, ".mjs"),
    outputRoot,
  );
  const source = await readFile(sourceUrl, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: sourceUrl.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  let compiledSource = outputText;
  for (const entry of [...ts.preProcessFile(outputText).importedFiles].reverse()) {
    const specifier = entry.fileName;
    const resolved = specifier.endsWith("?raw")
      ? `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(await readFile(new URL(specifier.slice(0, -4), sourceUrl), "utf8"))};`)}`
      : specifier.startsWith(".")
      ? await loadSource(new URL(`${specifier}.ts`, sourceUrl).href)
      : import.meta.resolve(specifier);
    compiledSource = compiledSource
      .replaceAll(`"${specifier}"`, `"${resolved}"`)
      .replaceAll(`'${specifier}'`, `"${resolved}"`);
  }
  await mkdir(new URL(".", outputUrl), { recursive: true });
  await writeFile(outputUrl, compiledSource);
  modules.set(sourceUrl.href, outputUrl.href);
  return outputUrl.href;
}
