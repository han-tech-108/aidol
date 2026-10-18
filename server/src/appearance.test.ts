import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boundedUpdate, FaceTuner } from "./face.ts";
import { complimentRate, isAppearanceTalk, isCompliment, PreferenceTracker } from "./preferences.ts";
import { writeJson } from "./store.ts";
import type { FaceParams } from "./protocol.ts";

const base: FaceParams = {
  version: 1,
  emotions: { neutral: {}, joy: { happy: 0.75 }, fun: { relaxed: 0.7 }, angry: { angry: 0.7 }, sorrow: { sad: 0.7 }, surprised: { surprised: 0.8 } },
  mouthGain: 1,
  blinkMin: 1.5,
  blinkMax: 6,
  gazeJitter: 0.25,
  note: "",
};

test("顔の調整は1回あたり一定幅までしか動かない", () => {
  const next = boundedUpdate(base, {
    ...base,
    emotions: { ...base.emotions, joy: { happy: 0.1, relaxed: 0.9 } },
    mouthGain: 3,
    blinkMin: 0,
    blinkMax: 1,
  });
  assert.equal(next.emotions.joy.happy, 0.6);
  assert.equal(next.emotions.joy.relaxed, 0.15);
  assert.equal(next.mouthGain, 1.15);
  assert.equal(next.blinkMin, 1.35);
  assert.ok(next.blinkMax >= next.blinkMin + 0.5);
});

test("褒め言葉と見た目の話題を見分ける", () => {
  assert.equal(isCompliment("今日も可愛いね"), true);
  assert.equal(isCompliment("こんばんは"), false);
  assert.equal(isAppearanceTalk("ポニテ見たい！"), true);
  assert.equal(isAppearanceTalk("ゲームやって"), false);
});

test("見た目ごとに反応を数える", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aidol-"));
  const prefs = new PreferenceTracker(path.join(dir, "prefs.json"));
  prefs.tick("a", 1, 60);
  assert.equal(prefs.observe({ source: "admin", author: "x", text: "その服かわいい" }, "a", 1), true);
  assert.equal(prefs.looks.a!.compliments, 1);
  assert.equal(complimentRate(prefs.looks.a), 1);
  assert.equal(complimentRate({ minutes: 10, comments: 0, compliments: 5 }), null);
});

test("新しい顔の反応が前の版より大きく悪ければ元に戻す", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aidol-"));
  const prefs = new PreferenceTracker(path.join(dir, "prefs.json"));
  writeJson(path.join(dir, "face/history/v1.json"), base);
  writeJson(path.join(dir, "face/current.json"), { ...base, version: 2, mouthGain: 1.2 });
  const tuner = new FaceTuner(path.join(dir, "face"), base, prefs, "unused");
  prefs.tick("a", 1, 120);
  prefs.tick("a", 2, 120);
  for (let i = 0; i < 10; i++) prefs.observe({ source: "admin", author: "x", text: "かわいい" }, "a", 1);
  prefs.observe({ source: "admin", author: "x", text: "かわいい" }, "a", 2);
  const r = tuner.checkRollback();
  assert.equal(r?.kind, "rolled-back");
  assert.equal(tuner.params.version, 1);
  assert.equal(tuner.params.mouthGain, 1);
});
