#!/usr/bin/env node

/**
 * One-shot generator for the matte texture tiles in ../assets/.
 *
 * The tiles are checked into git and loaded at render time by
 * collage_service.js — this script exists so the tiles are reproducible,
 * not because it runs in production. Everything is seeded (mulberry32,
 * wrapped value-noise lattices), so re-running it yields byte-identical
 * pixel data. Both tiles are 512x512 8-bit greyscale, centered on 128
 * (soft-light neutral), and seamless: noise lattices wrap at the tile
 * edge and periodic terms use periods that divide 512.
 *
 * Usage: node scripts/generate-texture-tiles.js
 */

const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');

const SIZE = 512;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Seamless value noise: random values on a (SIZE/period)^2 lattice,
 * smoothstep-interpolated, lattice indices wrapped so opposite tile
 * edges meet exactly. Returns f(x, y) in [-1, 1].
 */
function makeWrappedNoise(seed, period, stretchX = 1) {
  const cells = Math.max(1, Math.round(SIZE / period));
  const rng = mulberry32(seed);
  const lattice = new Float64Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) {
    lattice[i] = rng() * 2 - 1;
  }
  const at = (cx, cy) => lattice[((cy % cells + cells) % cells) * cells + ((cx % cells + cells) % cells)];

  return (x, y) => {
    const fx = (x / stretchX) / period;
    const fy = y / period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smoothstep(fx - x0);
    const ty = smoothstep(fy - y0);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

function clampByte(v) {
  return Math.min(255, Math.max(0, Math.round(v)));
}

/** Paper fibre: fine isotropic grain + faint horizontal streaks + soft clouds. */
function fibreTile() {
  const grain = makeWrappedNoise(0xf1b4e001, 4);
  const streaks = makeWrappedNoise(0xf1b4e002, 16, 4);
  const clouds = makeWrappedNoise(0xf1b4e003, 64);

  const data = Buffer.allocUnsafe(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      data[y * SIZE + x] = clampByte(
        128 + grain(x, y) * 11 + streaks(x, y) * 6 + clouds(x, y) * 4
      );
    }
  }
  return data;
}

/** Linen weave: perpendicular thread ridges + over/under checker + grain. */
function weaveTile() {
  const THREAD = 8; // px per thread; 512 % 8 === 0 keeps the tile seamless
  const grain = makeWrappedNoise(0x11ea7e01, 4);
  const warp = makeWrappedNoise(0x11ea7e02, 32);

  const data = Buffer.allocUnsafe(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const tx = Math.sin((2 * Math.PI * x) / THREAD);
      const ty = Math.sin((2 * Math.PI * y) / THREAD);
      const checker = (Math.floor(x / THREAD) + Math.floor(y / THREAD)) % 2 === 0 ? 1 : -1;
      data[y * SIZE + x] = clampByte(
        128 + tx * 6 + ty * 6 + checker * 3 + grain(x, y) * 3 + warp(x, y) * 2
      );
    }
  }
  return data;
}

async function writeTile(name, pixels) {
  const outPath = path.join(__dirname, '..', 'assets', name);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`wrote ${outPath}`);
}

async function main() {
  await writeTile('texture-fibre.png', fibreTile());
  await writeTile('texture-weave.png', weaveTile());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
