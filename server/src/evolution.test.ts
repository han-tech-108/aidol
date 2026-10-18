import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify, Metrics, score } from "./evolution/metrics.ts";
import { VersionedStore } from "./evolution/versioned.ts";
import { EvolutionEngine, type Domain } from "./evolution/engine.ts";
import { boundedFace } from "./evolution/domains/face.ts";
import { motionDomain } from "./evolution/domains/motion.ts";
import { DEFAULT_MODEL, modelEdits } from "./evolution/domains/model.ts";
import { readGlb, writeGlb } from "./assets/glb.ts";
import { applyEdits, ModelBuilder, partOf } from "./assets/builder.ts";
import { hslToRgb, recolorPixel, rgbToHsl } from "./assets/recolor.ts";
import type { FaceParams } from "./protocol.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "aidol-"));
const MODEL_FILE = path.join(import.meta.dirname, "../../avatar/public/models/avatar.vrm");

test("コメントを項目ごとの褒め・不満に分ける", () => {
  assert.equal(classify("声かわいい").voice, "positive");
  assert.equal(classify("声が聞き取りにくい").voice, "negative");
  assert.equal(classify("草").persona, "positive");
  assert.deepEqual(classify("こんばんは"), {});
});

test("評価点は使用時間が足りないと null", () => {
  assert.equal(score({ minutes: 10, comments: 5, positives: 0, negatives: 0 }, 30), null);
  assert.equal(score({ minutes: 60, comments: 30, positives: 2, negatives: 1 }, 30), 30);
});

test("版の保存と巻き戻し", () => {
  const s = new VersionedStore(tmp(), { a: 1 });
  s.commit({ a: 2 }, "上げる");
  assert.equal(s.current.version, 2);
  assert.equal(s.previous(), 1);
  s.restore(1);
  assert.deepEqual(s.current.value, { a: 1 });
  assert.deepEqual(s.versions(), [1, 2]);
});

function fakeEngine(proposed: number) {
  const dir = tmp();
  const metrics = new Metrics(path.join(dir, "metrics.json"));
  const engine = new EvolutionEngine(dir, metrics, () => "look");
  const applied: number[] = [];
  const domain: Domain<number> = {
    id: "motion",
    label: "テスト",
    initial: 1,
    minMinutes: 2,
    cooldownMinutes: 5,
    propose: async () => ({ value: proposed, rationale: "試す" }),
    sanitize: (_prev, next) => Math.min(next, 10),
    apply: (v) => void applied.push(v),
  };
  engine.register(domain);
  return { engine, metrics, applied };
}

async function live(engine: EvolutionEngine, metrics: Metrics, minutes: number, commentsPerMinute: number) {
  for (let i = 0; i < minutes; i++) {
    for (let j = 0; j < commentsPerMinute; j++) metrics.observe({ source: "admin", author: "a", text: "こんにちは" }, engine.activeVersions());
    metrics.tick(engine.activeVersions());
    await engine.tick();
  }
}

test("反応が下がった改善は自動で元に戻す", async () => {
  const { engine, metrics, applied } = fakeEngine(5);
  // 元の版で十分な反応を貯めてから、候補を試させる
  metrics.tick(engine.activeVersions(), 10);
  for (let j = 0; j < 20; j++) metrics.observe({ source: "admin", author: "a", text: "やっほー" }, engine.activeVersions());
  await engine.tick();
  assert.equal(engine.version("motion"), 2);
  await live(engine, metrics, 3, 0);
  assert.equal(engine.version("motion"), 1);
  assert.deepEqual(applied, [5, 1]);
  assert.match(readFileSync(path.join((engine as unknown as { dir: string }).dir, "changelog.md"), "utf8"), /戻しました/);
});

test("反応が保たれた改善は採用する", async () => {
  const { engine, metrics } = fakeEngine(7);
  metrics.tick(engine.activeVersions(), 10);
  await engine.tick();
  await live(engine, metrics, 3, 2);
  assert.equal(engine.version("motion"), 2);
  assert.equal(engine.value<number>("motion"), 7);
});

test("凍結・一時停止中は改善を試さない", async () => {
  const { engine } = fakeEngine(5);
  engine.setFrozen("motion", true);
  await engine.tick();
  assert.equal(engine.version("motion"), 1);
  engine.setFrozen("motion", false);
  engine.setPaused(true);
  await engine.tick();
  assert.equal(engine.version("motion"), 1);
});

test("表情の調整は1回あたり一定幅まで", () => {
  const base: FaceParams = {
    emotions: { neutral: {}, joy: { happy: 0.75 }, fun: { relaxed: 0.7 }, angry: { angry: 0.7 }, sorrow: { sad: 0.7 }, surprised: { surprised: 0.8 } },
    mouthGain: 1,
    blinkMin: 1.5,
    blinkMax: 6,
    gazeJitter: 0.25,
  };
  const next = boundedFace(base, { ...base, emotions: { ...base.emotions, joy: { happy: 0.1, relaxed: 0.9 } }, mouthGain: 3, blinkMin: 0, blinkMax: 1 });
  assert.equal(next.emotions.joy.happy, 0.6);
  assert.equal(next.emotions.joy.relaxed, 0.15);
  assert.equal(next.mouthGain, 1.15);
  assert.ok(next.blinkMax >= next.blinkMin + 0.5);
});

test("動きの調整も範囲内に収める", () => {
  const d = motionDomain({ initial: { gestureScale: 1, gestureSpeed: 1, idleScale: 1, speakingNod: 1 }, apply: () => {} });
  const v = d.sanitize(d.initial, { gestureScale: 9, gestureSpeed: -1, idleScale: 1, speakingNod: NaN });
  assert.equal(v.gestureScale, 1.15);
  assert.equal(v.gestureSpeed, 0.85);
  assert.ok(Number.isFinite(v.speakingNod));
});

test("色の変換と部位の判定", () => {
  const [h, s, l] = rgbToHsl(0.8, 0.2, 0.4);
  assert.deepEqual(hslToRgb(h, s, l).map((x) => Math.round(x * 100)), [80, 20, 40]);
  const [r, g, b] = recolorPixel(0.8, 0.2, 0.2, { hue: 220 }, 220 - rgbToHsl(0.8, 0.2, 0.2)[0]);
  assert.ok(b > r && b > g);
  assert.equal(partOf("F00_000_Hair_00_HAIR"), "hair");
  assert.equal(partOf("N00_001_01_Tops_01_CLOTH"), "tops");
  assert.equal(partOf("HairBack_00_HAIR"), "hair");
  assert.equal(partOf("Tops_01_CLOTH"), "tops");
  assert.equal(partOf("EyeIris_00_EYE"), "eye");
  assert.equal(partOf("N00_000_00_FaceMouth_00_FACE"), null);
  assert.equal(partOf("Body_00_SKIN"), null);
  assert.deepEqual(modelEdits(DEFAULT_MODEL), {});
});

test("VRM の読み書きと色替え", { skip: !existsSync(MODEL_FILE) && "サンプル VRM がありません" }, () => {
  const src = readFileSync(MODEL_FILE);
  const glb = readGlb(src);
  assert.deepEqual(readGlb(writeGlb(glb)).json, glb.json);
  const { data, changedParts } = applyEdits(src, { colors: { hair: { hue: 200 } }, mtoon: { outlineScale: 0.8 } });
  assert.ok(changedParts.includes("hair"));
  assert.ok(readGlb(data).json.materials!.length === glb.json.materials!.length);

  const dir = tmp();
  const builder = new ModelBuilder(path.join(MODEL_FILE, "../.."), dir);
  const out = builder.build("/models/avatar.vrm", { colors: { hair: { hue: 200 } } });
  assert.match(out, /^\/generated\/\w+\.vrm$/);
  assert.equal(builder.build("/models/avatar.vrm", { colors: { hair: { hue: 200 } } }), out);
  assert.ok(builder.exists(out));
  assert.equal(builder.build("/models/avatar.vrm", {}), "/models/avatar.vrm");
});
