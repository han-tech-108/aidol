/**
 * GLB（VRM の中身）を読み書きする最小限の実装。
 * JSON 部分と、バイナリを bufferView ごとに切り分けたものを扱い、書き戻すときに詰め直す。
 */

export interface Gltf {
  materials?: GltfMaterial[];
  textures?: { source?: number }[];
  images?: { name?: string; mimeType?: string; bufferView?: number }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }[];
  buffers: { byteLength: number }[];
  [k: string]: unknown;
}

export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number } };
  extensions?: { VRMC_materials_mtoon?: Record<string, unknown> & { shadeColorFactor?: number[]; shadeMultiplyTexture?: { index: number } } };
}

export interface Glb {
  json: Gltf;
  views: Buffer[];
}

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export function readGlb(buf: Buffer): Glb {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error("GLB ファイルではありません");
  let offset = 12;
  let json: Gltf | null = null;
  let bin: Buffer = Buffer.alloc(0);
  while (offset < buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString("utf8"));
    else if (type === BIN_CHUNK) bin = data;
    offset += 8 + len;
  }
  if (!json) throw new Error("GLB に JSON がありません");
  const views = json.bufferViews.map((v) => Buffer.from(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)));
  return { json, views };
}

const pad4 = (n: number) => (n + 3) & ~3;

export function writeGlb({ json, views }: Glb): Buffer {
  // bufferView を 4 バイト境界に揃えて詰め直す
  let offset = 0;
  const parts: Buffer[] = [];
  views.forEach((data, i) => {
    const view = json.bufferViews[i]!;
    view.buffer = 0;
    view.byteOffset = offset;
    view.byteLength = data.length;
    parts.push(data);
    const padded = pad4(data.length);
    if (padded > data.length) parts.push(Buffer.alloc(padded - data.length));
    offset += padded;
  });
  const bin = Buffer.concat(parts);
  json.buffers = [{ byteLength: bin.length }];

  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunk = (type: number, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(JSON_CHUNK, jsonPadded), chunk(BIN_CHUNK, bin)]);
}
