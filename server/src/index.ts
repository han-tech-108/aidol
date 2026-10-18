import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Brain } from "./llm.ts";
import { VoicevoxClient } from "./tts.ts";
import { buildSystemPrompt, loadCharacter } from "./character.ts";
import { containsNgWord } from "./filter.ts";
import { parseTags, SentenceSplitter } from "./tags.ts";
import type { AdminToServer, Comment, Emotion, ServerToAdmin, ServerToAvatar, SpeakMessage } from "./protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const MAX_PENDING = 5;

const character = loadCharacter(path.join(here, "../../config/character.json"));
const brain = new Brain(
  buildSystemPrompt(character),
  process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
  (process.env.CLAUDE_EFFORT ?? "low") as "low",
);
const tts = new VoicevoxClient(
  process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021",
  Number(process.env.VOICEVOX_SPEAKER ?? 1),
);

// ---- 接続管理 ----
const avatars = new Set<WebSocket>();
const admins = new Set<WebSocket>();

function toAvatars(msg: ServerToAvatar) {
  const data = JSON.stringify(msg);
  for (const ws of avatars) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function log(level: ServerToAdmin["level"], message: string) {
  const entry: ServerToAdmin = { type: "log", level, at: new Date().toISOString(), message };
  console[level === "info" ? "log" : level](`[${level}] ${message}`);
  const data = JSON.stringify(entry);
  for (const ws of admins) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// ---- 発話 ----
let ttsAvailable = false;

async function toSpeak(turnId: string, index: number, text: string, emotion: Emotion, gestures: SpeakMessage["gestures"]) {
  const msg: SpeakMessage = { type: "speak", turnId, index, text, emotion, gestures, duration: Math.max(1, text.length * 0.13) };
  if (ttsAvailable) {
    try {
      const speech = await tts.synthesize(text);
      msg.audio = speech.wav.toString("base64");
      msg.visemes = speech.visemes;
      msg.duration = speech.duration;
    } catch (e) {
      log("warn", `音声合成に失敗したので音声なしで続けます: ${(e as Error).message}`);
    }
  }
  return msg;
}

// ---- コメント処理（1件ずつ順番に） ----
const pending: Comment[] = [];
let current: AbortController | null = null;
let draining = false;

function enqueue(c: Comment) {
  if (containsNgWord(c.text, character.ngWords) || containsNgWord(c.author, character.ngWords)) {
    log("warn", `NGワードを含むコメントを除外: ${c.author}`);
    return;
  }
  pending.push(c);
  while (pending.length > MAX_PENDING) pending.shift();
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length) await respondTo(pending.shift()!);
  } finally {
    draining = false;
  }
}

async function respondTo(c: Comment) {
  const turnId = randomUUID();
  const controller = new AbortController();
  current = controller;
  log("info", `コメント (${c.source}) ${c.author}: ${c.text}`);

  const userContent = `<comment author="${escapeAttr(c.author)}">${escapeText(c.text)}</comment>`;
  const splitter = new SentenceSplitter();
  let emotion: Emotion = "neutral";
  let index = 0;
  let spoken = "";
  // 文ごとに音声合成し、届いた順にアバターへ送る
  let chain = Promise.resolve();

  const handle = (raw: string) => {
    const s = parseTags(raw);
    if (!s.text) return;
    if (containsNgWord(s.text, character.ngWords)) {
      log("error", `生成文にNGワードがあったため発話を中止: ${s.text}`);
      controller.abort();
      return;
    }
    emotion = s.emotion ?? emotion;
    spoken += raw;
    const i = index++;
    const e = emotion;
    const job = toSpeak(turnId, i, s.text, e, s.gestures);
    chain = chain.then(async () => {
      const msg = await job;
      if (!controller.signal.aborted) {
        toAvatars(msg);
        log("info", `発話 [${e}${s.gestures.map((g) => "/" + g).join("")}] ${s.text}`);
      }
    });
  };

  try {
    for await (const delta of brain.respond(userContent, controller.signal)) {
      for (const sentence of splitter.push(delta)) handle(sentence);
      if (controller.signal.aborted) break;
    }
    for (const sentence of splitter.flush()) handle(sentence);
  } catch (e) {
    if (controller.signal.aborted) {
      brain.remember(userContent, spoken);
    } else {
      log("error", `応答の生成に失敗: ${(e as Error).message}`);
    }
  }
  await chain;
  if (current === controller) current = null;
}

function stopAll() {
  pending.length = 0;
  current?.abort();
  toAvatars({ type: "stop" });
  log("warn", "管理画面から停止しました");
}

function escapeAttr(s: string) {
  return s.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
function escapeText(s: string) {
  return s.replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// ---- サーバー ----
const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, avatars: avatars.size, tts: ttsAvailable }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http });
wss.on("connection", (ws, req) => {
  const role = new URL(req.url ?? "/", "http://x").searchParams.get("role");
  if (role === "avatar") {
    avatars.add(ws);
    log("info", `アバターが接続しました（${avatars.size}）`);
    ws.on("close", () => avatars.delete(ws));
    return;
  }
  admins.add(ws);
  ws.on("close", () => admins.delete(ws));
  ws.on("message", async (data) => {
    let msg: AdminToServer;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.type) {
      case "comment":
        enqueue({ source: "admin", author: msg.author || "名無し", text: msg.text });
        break;
      case "say": {
        const s = parseTags(msg.text);
        if (s.text) toAvatars(await toSpeak(randomUUID(), 0, s.text, s.emotion ?? "neutral", s.gestures));
        break;
      }
      case "gesture":
        toAvatars({ type: "pose", gesture: msg.gesture });
        break;
      case "stop":
        stopAll();
        break;
    }
  });
});

http.listen(PORT, async () => {
  ttsAvailable = await tts.isAvailable();
  console.log(`aidol server: ws://localhost:${PORT}`);
  console.log(ttsAvailable ? "VOICEVOX に接続しました" : "VOICEVOX が見つからないため、音声なし（口パクのみ）で動作します");
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY が未設定です。.env に設定してください");
});
