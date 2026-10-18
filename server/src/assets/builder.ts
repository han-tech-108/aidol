import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readGlb, writeGlb, type GltfMaterial } from "./glb.ts";
import { recolorFactor, recolorPng } from "./recolor.ts";
import type { ColorEdit, LookEdits, MtoonEdit, Part } from "../protocol.ts";

/** VRoid Studio が書き出すマテリアル名から部位を見分ける（例: Tops_01_CLOTH, N00_001_01_Tops_01_CLOTH_01） */
const PART_PATTERNS: Record<Part, RegExp> = {
  hair: /(^|_)Hair\w*_HAIR(_\d+)?\b/i,
  tops: /(^|_)Tops_\w*CLOTH/i,
  bottoms: /(^|_)Bottoms_\w*CLOTH/i,
  onepiece: /(^|_)Onepiece_\w*CLOTH/i,
  shoes: /(^|_)Shoes_\w*CLOTH/i,
  accessory: /(^|_)Accessory|_ACCE/i,
  eye: /(^|_)EyeIris/i,
};

export function partOf(materialName: string | undefined): Part | null {
  if (!materialName) return null;
  for (const [part, re] of Object.entries(PART_PATTERNS) as [Part, RegExp][]) if (re.test(materialName)) return part;
  return null;
}

/** 2つの変更を合わせる（後から指定したものを優先） */
export function mergeEdits(a: LookEdits = {}, b: LookEdits = {}): LookEdits {
  return { colors: { ...a.colors, ...b.colors }, mtoon: { ...a.mtoon, ...b.mtoon } };
}

const isEmpty = (e: LookEdits) => !Object.keys(e.colors ?? {}).length && !Object.keys(e.mtoon ?? {}).length;

/** VRM のバイト列に変更を加えた、新しいバイト列を返す。 */
export function applyEdits(vrm: Buffer, edits: LookEdits): { data: Buffer; changedParts: Part[] } {
  const glb = readGlb(vrm);
  const { json, views } = glb;
  const changedParts = new Set<Part>();
  const imageEdits = new Map<number, ColorEdit>();
  const textureImage = (texIndex: number | undefined) => (texIndex === undefined ? undefined : json.textures?.[texIndex]?.source);

  for (const m of json.materials ?? []) {
    const part = partOf(m.name);
    const color = part ? edits.colors?.[part] : undefined;
    if (part && color) {
      changedParts.add(part);
      for (const img of [textureImage(m.pbrMetallicRoughness?.baseColorTexture?.index), textureImage(m.extensions?.VRMC_materials_mtoon?.shadeMultiplyTexture?.index)]) {
        if (img !== undefined) imageEdits.set(img, color);
      }
      if (m.pbrMetallicRoughness?.baseColorFactor) m.pbrMetallicRoughness.baseColorFactor = recolorFactor(m.pbrMetallicRoughness.baseColorFactor, color);
      const mt = m.extensions?.VRMC_materials_mtoon;
      if (mt?.shadeColorFactor) mt.shadeColorFactor = recolorFactor(mt.shadeColorFactor, color);
    }
    if (edits.mtoon) applyMtoon(m, edits.mtoon);
  }

  for (const [imgIndex, color] of imageEdits) {
    const img = json.images?.[imgIndex];
    if (img?.bufferView === undefined || img.mimeType !== "image/png") continue;
    views[img.bufferView] = recolorPng(views[img.bufferView]!, color);
  }
  return { data: writeGlb(glb), changedParts: [...changedParts] };
}

function applyMtoon(m: GltfMaterial, e: MtoonEdit) {
  const mt = m.extensions?.VRMC_materials_mtoon as Record<string, unknown> | undefined;
  if (!mt) return; // VRM 0.x の MToon は未対応
  if (e.outlineScale !== undefined && typeof mt.outlineWidthFactor === "number") mt.outlineWidthFactor *= e.outlineScale;
  if (e.shadingToony !== undefined) mt.shadingToonyFactor = e.shadingToony;
  if (e.shadingShift !== undefined) mt.shadingShiftFactor = e.shadingShift;
  if (e.rimLift !== undefined) {
    mt.parametricRimLiftFactor = e.rimLift;
    mt.parametricRimColorFactor = [0.25, 0.25, 0.25];
  }
}

/**
 * 変更を加えた VRM を作ってキャッシュする。
 * 返り値はアバターが読み込むパス（/generated/<hash>.vrm）。変更が無ければ元のパスをそのまま返す。
 */
export class ModelBuilder {
  constructor(
    /** avatar/public */
    private publicDir: string,
    /** 作った VRM の置き場所。サーバーが /generated/ で配信する */
    private outDir: string,
  ) {}

  resolveSource(file: string): string {
    return file.startsWith("/generated/") ? path.join(this.outDir, path.basename(file)) : path.join(this.publicDir, file);
  }

  exists(file: string) {
    return existsSync(this.resolveSource(file));
  }

  build(sourceFile: string, edits: LookEdits): string {
    if (isEmpty(edits)) return sourceFile;
    const src = this.resolveSource(sourceFile);
    const hash = createHash("sha1")
      .update(`${src}:${statSync(src).mtimeMs}:${JSON.stringify(edits)}`)
      .digest("hex")
      .slice(0, 16);
    const name = `${hash}.vrm`;
    const out = path.join(this.outDir, name);
    if (!existsSync(out)) {
      mkdirSync(this.outDir, { recursive: true });
      writeFileSync(out, applyEdits(readFileSync(src), edits).data);
    }
    return `/generated/${name}`;
  }
}
