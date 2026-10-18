import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTags, SentenceSplitter } from "./tags.ts";
import { visemesFromQuery } from "./tts.ts";
import { containsNgWord } from "./filter.ts";

test("タグを取り出して本文だけ残す", () => {
  assert.deepEqual(parseTags("[joy][wave]こんにちは！"), { text: "こんにちは！", emotion: "joy", gestures: ["wave"] });
  assert.deepEqual(parseTags("[unknown]普通の文。"), { text: "普通の文。", emotion: undefined, gestures: [] });
});

test("ストリームを文ごとに切る", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("[joy]こんにち"), []);
  assert.deepEqual(s.push("は！"), []);
  assert.deepEqual(s.push("？[fun]今日も"), ["[joy]こんにちは！？"]);
  assert.deepEqual(s.push("来てくれてうれしい。[nod]"), ["[fun]今日も来てくれてうれしい。"]);
  assert.deepEqual(s.push("またね"), []);
  assert.deepEqual(s.flush(), ["[nod]またね"]);
});

test("audio_query から口の形の時刻を作る", () => {
  const { visemes, duration } = visemesFromQuery({
    speedScale: 1,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    accent_phrases: [
      { moras: [{ consonant_length: 0.05, vowel: "o", vowel_length: 0.1 }, { consonant_length: null, vowel: "N", vowel_length: 0.1 }], pause_mora: null },
    ],
  });
  assert.deepEqual(visemes.map((v) => v.vowel), ["o", "N", "pau"]);
  assert.ok(Math.abs(visemes[0]!.t - 0.15) < 1e-9);
  assert.ok(Math.abs(duration - 0.45) < 1e-9);
});

test("NGワードは全角半角を区別せず見つける", () => {
  assert.equal(containsNgWord("ＢＡＤ word", ["bad"]), true);
  assert.equal(containsNgWord("good", ["bad"]), false);
});
