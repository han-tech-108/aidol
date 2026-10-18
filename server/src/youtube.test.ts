import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDuration, toChatItem, YouTubeClient, YouTubeLive } from "./youtube.ts";
import { describeStats, Metrics, score, scoreMode, type ActiveVersions } from "./evolution/metrics.ts";
import type { Comment } from "./protocol.ts";

const active = (look = "a", persona = "1"): ActiveVersions => ({ persona, voice: "1", face: "1", motion: "1", model: "1", look });
const newMetrics = () => new Metrics(path.join(mkdtempSync(path.join(tmpdir(), "aidol-")), "m.json"));

test("チャットの種類ごとに返事用の形にする", () => {
  const author = { displayName: "たろう" };
  assert.deepEqual(toChatItem({ id: "1", snippet: { type: "textMessageEvent", displayMessage: "こんにちは" }, authorDetails: author }), {
    id: "1",
    type: "textMessageEvent",
    author: "たろう",
    text: "こんにちは",
  });
  const sc = toChatItem({ id: "2", snippet: { type: "superChatEvent", superChatDetails: { amountDisplayString: "¥500", userComment: "応援" } }, authorDetails: author });
  assert.equal(sc?.gift, "スーパーチャット ¥500");
  assert.equal(sc?.text, "応援");
  assert.equal(toChatItem({ id: "3", snippet: { type: "newSponsorEvent" }, authorDetails: author })?.gift, "メンバー加入");
  assert.equal(toChatItem({ id: "4", snippet: { type: "chatEndedEvent" } }), null);
  assert.equal(parseDuration("PT1H2M3S"), 3723);
  assert.equal(parseDuration("P0D"), 0);
});

test("OAuth で自分の配信を探し、つないだ後のコメントだけ返す", async () => {
  const calls: string[] = [];
  let chatPage = 0;
  const fake = (async (input: string | URL) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "t", expires_in: 3600 });
    if (u.pathname.endsWith("/liveBroadcasts")) return json({ items: [{ id: "vid" }] });
    if (u.pathname.endsWith("/videos"))
      return json({ items: [{ id: "vid", liveStreamingDetails: { activeLiveChatId: "chat", concurrentViewers: "42", actualStartTime: "2026-10-18T10:00:00Z" } }] });
    if (u.pathname.endsWith("/liveChat/messages")) {
      chatPage++;
      const msg = (id: string, text: string) => ({ id, snippet: { type: "textMessageEvent", displayMessage: text }, authorDetails: { displayName: "a" } });
      return json({ nextPageToken: `p${chatPage}`, pollingIntervalMillis: 1, items: chatPage === 1 ? [msg("old", "前のコメント")] : [msg(`n${chatPage}`, "新しいコメント")] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const client = new YouTubeClient({ clientId: "c", clientSecret: "s", refreshToken: "r", chatPollMs: 1 }, fake);
  const comments: Comment[] = [];
  let videoSeen = "";
  const live = new YouTubeLive(client, { onComment: (c) => comments.push(c), onVideo: (v) => (videoSeen = v.videoId), log: () => {} });
  void live.start();
  while (comments.length < 2) await new Promise((r) => setTimeout(r, 5));
  live.stop();
  assert.equal(videoSeen, "vid");
  assert.equal(live.viewers, 42);
  assert.ok(comments.every((c) => c.text === "新しいコメント" && c.source === "youtube"));
  assert.ok(calls.includes("/youtube/v3/liveBroadcasts"));
});

test("視聴者数があれば視聴者あたりで評価し、増えている版を高くする", () => {
  const m = newMetrics();
  for (let i = 0; i < 60; i++) m.tick(active("grow"), 1, 100 + i); // 視聴者が増える
  for (let i = 0; i < 60; i++) m.tick(active("shrink"), 1, 160 - i); // 減る
  for (let i = 0; i < 30; i++) {
    m.observe({ source: "youtube", author: "a", text: "やっほー" }, active("grow"));
    m.observe({ source: "youtube", author: "a", text: "やっほー" }, active("shrink"));
  }
  const g = m.stats("look", "grow");
  const s = m.stats("look", "shrink");
  assert.equal(scoreMode(g, s), "viewers");
  assert.ok(score(g, 30, "viewers")! > score(s, 30, "viewers")!);
  // 視聴者数のない版と比べるときはコメント数で比べる
  m.tick(active("nodata"), 60);
  assert.equal(scoreMode(g, m.stats("look", "nodata")), "comments");
  assert.match(describeStats(m, "look"), /平均同時視聴者/);
});

test("アーカイブの視聴維持率を、そのとき使っていた版に振り分ける", () => {
  const m = newMetrics();
  const start = new Date(Date.now() - 60 * 60_000).toISOString();
  m.startSession("vid", start, active("a", "1"));
  // セッション開始直後の版の切り替えを、時刻を指定して記録する
  const session = m.pendingSessions()[0]!;
  session.segments = [
    { at: start, active: active("a", "1") },
    { at: new Date(Date.parse(start) + 30 * 60_000).toISOString(), active: active("a", "2") },
  ];
  m.addRetention(
    "vid",
    [
      { ratio: 0, watch: 1 },
      { ratio: 0.25, watch: 0.9 },
      { ratio: 0.5, watch: 0.8 },
      { ratio: 0.75, watch: 0.5 },
      { ratio: 1, watch: 0.2 },
    ],
    3600,
  );
  const v1 = m.stats("persona", "1");
  const v2 = m.stats("persona", "2");
  assert.equal(v1.retentionMinutes, 30);
  assert.equal(v2.retentionMinutes, 30);
  assert.ok(v2.retentionDrop! > v1.retentionDrop!);
  assert.equal(m.pendingSessions().length, 0);
  assert.match(describeStats(m, "persona", 0), /アーカイブの離脱/);
});

test("スパチャ等は評価に加点する", () => {
  const m = newMetrics();
  m.tick(active("x"), 60);
  const before = score(m.stats("look", "x"), 30)!;
  m.observeGift(active("x"));
  assert.ok(score(m.stats("look", "x"), 30)! > before);
});
