// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("static icon imports omit unused geometry and the dynamic registry", async () => {
  const result = await build({
    stdin: {
      contents: `import { companion } from './src/icons/glyphs';
        import { mimoIcon } from './src/icons/render';
        export const makeIcon = () => mimoIcon(companion, 18);`,
      resolveDir: projectRoot,
    },
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    metafile: true,
  });
  const code = result.outputFiles[0].text;
  assert.ok(code.includes('name:"companion"'));
  for (const name of ["winter", "music-mode", "secret", "sound-off", "light-mode"]) {
    assert.ok(!code.includes(`name:"${name}"`), `unused ${name} leaked into the bundle`);
  }
  assert.ok(!Object.keys(result.metafile.inputs).some(path => path.endsWith("icons/index.ts")));
  assert.ok(Buffer.byteLength(code) < 1800, "one icon and renderer should stay below 1.8 KB");
  assert.ok(gzipSync(code).length < 900, "one icon and renderer should stay below 900 B gzip");
});
