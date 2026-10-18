import { PNG } from "pngjs";
import type { ColorEdit } from "../protocol.ts";

export type { ColorEdit };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hh = h / 360;
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)];
}

/** 色の付いた画素の、彩度で重み付けした平均色相 */
function dominantHue(data: Uint8Array): number | null {
  let x = 0;
  let y = 0;
  let total = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3]! < 16) continue;
    n++;
    const [h, s, l] = rgbToHsl(data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255);
    const w = s * (1 - Math.abs(2 * l - 1));
    x += Math.cos((h * Math.PI) / 180) * w;
    y += Math.sin((h * Math.PI) / 180) * w;
    total += w;
  }
  // ほとんど色が付いていない（白・黒・灰色の服など）
  if (!n || total / n < 0.06 || Math.hypot(x, y) < 1e-6) return null;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function recolorPixel(r: number, g: number, b: number, edit: ColorEdit, hueShift: number): [number, number, number] {
  let [h, s, l] = rgbToHsl(r, g, b);
  h = (h + hueShift + 360) % 360;
  s = clamp01(s * (edit.saturation ?? 1));
  l = clamp01(l + (edit.lightness ?? 0));
  return hslToRgb(h, s, l);
}

/** PNG 画像の色を変える。白黒に近い画像に色相を指定した場合は、薄く色を乗せる。 */
export function recolorPng(png: Buffer, edit: ColorEdit): Buffer {
  const img = PNG.sync.read(png);
  const data = img.data;
  const base = edit.hue === undefined ? null : dominantHue(data);
  const shift = edit.hue === undefined || base === null ? 0 : edit.hue - base;
  const tint = edit.hue !== undefined && base === null; // 元が無彩色
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let rgb: [number, number, number];
    if (tint) {
      const [, , l] = rgbToHsl(data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255);
      // 真っ白だと色が見えないので少しだけ暗くしてから色を乗せる
      rgb = hslToRgb(edit.hue!, clamp01(0.5 * (edit.saturation ?? 1)), clamp01(l * 0.88 + (edit.lightness ?? 0)));
    } else {
      rgb = recolorPixel(data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255, edit, shift);
    }
    data[i] = Math.round(rgb[0] * 255);
    data[i + 1] = Math.round(rgb[1] * 255);
    data[i + 2] = Math.round(rgb[2] * 255);
  }
  return PNG.sync.write(img);
}

/** 線形の色（glTF の Factor）にも同じ変更をかける */
export function recolorFactor(rgb: number[], edit: ColorEdit): number[] {
  if (edit.hue === undefined && edit.saturation === undefined && edit.lightness === undefined) return rgb;
  const toS = (c: number) => Math.pow(clamp01(c), 1 / 2.2);
  const toL = (c: number) => Math.pow(clamp01(c), 2.2);
  const [h0, s0] = rgbToHsl(toS(rgb[0]!), toS(rgb[1]!), toS(rgb[2]!));
  const shift = edit.hue === undefined || s0 < 0.05 ? 0 : edit.hue - h0;
  const out = recolorPixel(toS(rgb[0]!), toS(rgb[1]!), toS(rgb[2]!), { ...edit, hue: undefined }, shift);
  return [toL(out[0]), toL(out[1]), toL(out[2]), ...rgb.slice(3)];
}
