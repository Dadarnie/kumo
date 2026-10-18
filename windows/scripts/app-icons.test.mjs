// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { test } from "node:test";

// Decode exported PNGs independently to check actual alpha, not only a filename
// or a color-type flag. No image modification is performed by these checks.
function png(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = buffer.readUInt32BE(16),
    height = buffer.readUInt32BE(20);
  assert.equal(buffer[24], 8);
  assert.equal(buffer[25], 6);
  const parts = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at),
      type = buffer.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") parts.push(buffer.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts)),
    stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c,
      x = Math.abs(p - a),
      y = Math.abs(p - b),
      z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        filter = raw[y * (stride + 1)],
        value = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? pixels[at - 4] : 0,
        b = y ? pixels[at - stride] : 0,
        c = y && x >= 4 ? pixels[at - stride - 4] : 0;
      assert.ok(filter <= 4);
      pixels[at] = (value + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]) & 255;
    }
  return { width, height, alpha: (x, y) => pixels[(y * width + x) * 4 + 3] };
}

for (const [file, size] of [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
]) {
  test(`${file} preserves square sizing and transparent corners`, () => {
    const image = png(readFileSync(new URL(`../src-tauri/icons/${file}`, import.meta.url)));
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ])
      assert.equal(image.alpha(x, y), 0);
    // Allow one alpha unit of export rounding while keeping the artwork opaque.
    assert.ok(image.alpha(Math.floor(size / 2), Math.floor(size / 2)) >= 254);
  });
}

test("UI app mark covers the largest 64px placement at 400% Windows scaling", () => {
  const image = png(readFileSync(new URL("../src/assets/app-icon-ui.png", import.meta.url)));
  assert.ok(image.width >= 64 * 4);
  assert.equal(image.width, image.height);
  assert.equal(image.alpha(0, 0), 0);
});

test("Windows ICO contains seven valid PNG sizes with transparency", () => {
  const file = readFileSync(new URL("../src-tauri/icons/icon.ico", import.meta.url));
  assert.equal(file.readUInt16LE(2), 1);
  assert.equal(file.readUInt16LE(4), 7);
  let next = 6 + 7 * 16;
  for (let index = 0; index < 7; index++) {
    const at = 6 + index * 16,
      size = [16, 24, 32, 48, 64, 128, 256][index];
    const length = file.readUInt32LE(at + 8),
      offset = file.readUInt32LE(at + 12);
    assert.equal(offset, next);
    assert.equal(file.readUInt16LE(at + 6), 32);
    const image = png(file.subarray(offset, offset + length));
    assert.equal(image.width, size);
    assert.equal(image.height, size);
    // The supplied tile's 16px export can retain 3/255 corner alpha from
    // high-quality resampling; it remains visually transparent.
    assert.ok(image.alpha(0, 0) <= 3);
    next += length;
  }
  assert.equal(next, file.length);
});
