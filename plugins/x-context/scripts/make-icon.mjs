// Generates mcpb/icon.png (512×512): a rounded tile with three "text lines" and
// a small rising bar chart — writing + metrics. Pure Node, no image dependency.
// Run once with `node scripts/make-icon.mjs`; the PNG is committed.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 512;
const px = new Float32Array(S * S * 4);

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function sdRoundRect(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - w / 2 + r;
  const qy = Math.abs(y - cy) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function fill(shape, [r, g, b]) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const a = Math.min(1, Math.max(0, 0.5 - shape(x + 0.5, y + 0.5)));
      if (a === 0) continue;
      const i = (y * S + x) * 4;
      const under = px[i + 3];
      const out = a + under * (1 - a);
      px[i] = (r * a + px[i] * under * (1 - a)) / out;
      px[i + 1] = (g * a + px[i + 1] * under * (1 - a)) / out;
      px[i + 2] = (b * a + px[i + 2] * under * (1 - a)) / out;
      px[i + 3] = out;
    }
  }
}

const bg = [24, 24, 27];
const ink = [244, 244, 245];
const accent = [96, 165, 250];

fill((x, y) => sdRoundRect(x, y, 256, 256, 448, 448, 96), bg);
// text lines
fill((x, y) => sdRoundRect(x, y, 96 + 280 / 2, 150, 280, 40, 20), ink);
fill((x, y) => sdRoundRect(x, y, 96 + 220 / 2, 222, 220, 40, 20), ink);
fill((x, y) => sdRoundRect(x, y, 96 + 150 / 2, 294, 150, 40, 20), ink);
// rising bars
const baseline = 392;
[
  [300, 56],
  [352, 104],
  [404, 152],
].forEach(([cx, h]) => fill((x, y) => sdRoundRect(x, y, cx, baseline - h / 2, 36, h, 12), accent));

// PNG encoding (RGBA, 8-bit)
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(px[i]);
    raw[o + 1] = Math.round(px[i + 1]);
    raw[o + 2] = Math.round(px[i + 2]);
    raw[o + 3] = Math.round(px[i + 3] * 255);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../mcpb/icon.png", import.meta.url), png);
console.log(`mcpb/icon.png written (${png.length} bytes)`);
