import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Brain } from "./llm.ts";
import { VoicevoxClient } from "./tts.ts";
import { buildSystemPrompt, loadCharacter } from "./character.ts";
import { containsNgWord } from "./filter.ts";
import { parseTags, SentenceSplitter } from "./tags.ts";
import { PreferenceTracker } from "./preferences.ts";
import { Stylist, type StyleTrigger, type Wardrobe } from "./stylist.ts";
import { FaceTuner } from "./face.ts";
import { readJson } from "./store.ts";
import type {
  AdminState,
  AdminToServer,
  AvatarToServer,
  CaptureImage,
  Comment,
  Emotion,
  FaceParams,
  ServerToAdmin,
  ServerToAvatar,
  SpeakMessage,
} from "./protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const MAX_PENDING = 5;
const ROOT = path.join(here, "../..");
const DATA = path.join(ROOT, "data");
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
/** 配信中、この時間ごとに顔のレビューを自動で行う（0 で無効） */
const FACE_REVIEW_HOURS = Number(process.env.FACE_REVIEW_HOURS ?? 3);

const character = loadCharacter(path.join(ROOT, "config/character.json"));
const brain = new Brain(buildSystemPrompt(character), MODEL, (process.env.CLAUDE_EFFORT ?? "low") as "low");
const prefs = new PreferenceTracker(path.join(DATA, "preferences.json"));
const wardrobe = readJson<Wardrobe>(path.join(ROOT, "config/wardrobe.json"), { defaultLook: "", minMinutesBetweenChanges: 10, scenes: [], looks: [] });
const stylist = new Stylist(
  wardrobe,
  (look) => existsSync(path.join(ROOT, "avatar/public", look.file)),
  prefs,
  MODEL,
  path.join(DATA, "wishlist.md"),
);
const face = new FaceTuner(path.join(DATA, "face"), readJson<FaceParams>(path.join(ROOT, "config/face.json"), {} as FaceParams), prefs, MODEL);
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

function toAdmins(msg: ServerToAdmin) {
  const data = JSON.stringify(msg);
  for (const ws of admins) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function log(level: "info" | "warn" | "error", message: string) {
  console[level === "info" ? "log" : level](`[${level}] ${message}`);
  toAdmins({ type: "log", level, at: new Date().toISOString(), message });
}

function adminState(): AdminState {
  return {
    type: "state",
    scene: stylist.scene,
    scenes: wardrobe.scenes,
    look: stylist.current,
    looks: wardrobe.looks.map((l) => ({ ...l, available: stylist.available().includes(l) })),
    faceVersion: face.params.version,
  };
}

// ---- 発話 ----
let ttsAvailable = false;

/** タグ付きの台詞をそのまま喋らせる。 */
async function say(line: string) {
  const s = parseTags(line);
  if (s.text) toAvatars(await toSpeak(randomUUID(), 0, s.text, s.emotion ?? "neutral", s.gestures));
}

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
  if (prefs.observe(c, stylist.current.id, face.params.version)) scheduleRestyle();
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

// ---- 見た目：衣装・髪型の自動選択 ----
let restyleTimer: ReturnType<typeof setTimeout> | undefined;

/** 見た目についてのコメントは少しまとめてから判断する */
function scheduleRestyle() {
  clearTimeout(restyleTimer);
  restyleTimer = setTimeout(() => void restyle("request"), 45_000);
}

async function restyle(trigger: StyleTrigger) {
  try {
    const d = await stylist.decide(trigger);
    if (!d) return;
    log("info", `スタイリスト: ${d.look.name}（${d.reason}）`);
    if (d.changed) {
      toAvatars({ type: "look", look: d.look });
      await say(d.line);
    }
    toAdmins(adminState());
  } catch (e) {
    log("error", `見た目の選択に失敗: ${(e as Error).message}`);
  }
}

// ---- 顔の継続改良 ----
const captures = new Map<string, (images: CaptureImage[]) => void>();

function capture(): Promise<CaptureImage[]> {
  const ws = [...avatars].find((a) => a.readyState === WebSocket.OPEN);
  if (!ws) return Promise.reject(new Error("アバターが接続されていません"));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captures.delete(requestId);
      reject(new Error("顔の撮影がタイムアウトしました"));
    }, 30_000);
    captures.set(requestId, (images) => {
      clearTimeout(timer);
      resolve(images);
    });
    ws.send(JSON.stringify({ type: "capture", requestId } satisfies ServerToAvatar));
  });
}

let reviewing = false;
let minutesSinceReview = 0;

async function reviewFace() {
  if (reviewing) return;
  reviewing = true;
  minutesSinceReview = 0;
  try {
    log("info", "顔のレビューを始めます（各表情を撮影中）");
    const result = await face.review(await capture(), stylist.current);
    if (result.kind === "updated") {
      log("info", `顔を版${result.params.version}に更新: ${result.assessment}`);
      if (result.modelSuggestions.length) log("info", `モデル修正の提案 ${result.modelSuggestions.length}件を data/face/model-suggestions.md に記録`);
    } else {
      log("warn", `顔を前の版に戻しました: ${result.reason}`);
    }
    toAvatars({ type: "face", params: face.params });
    toAdmins(adminState());
  } catch (e) {
    log("error", `顔のレビューに失敗: ${(e as Error).message}`);
  } finally {
    reviewing = false;
  }
}

// 配信中（アバター接続中）は1分ごとに見た目の表示時間を数え、反応が悪い版は自動で戻す
setInterval(() => {
  if (!avatars.size) return;
  prefs.tick(stylist.current.id, face.params.version);
  minutesSinceReview++;
  const rolled = face.checkRollback();
  if (rolled?.kind === "rolled-back") {
    log("warn", `顔を前の版に戻しました: ${rolled.reason}`);
    toAvatars({ type: "face", params: face.params });
    toAdmins(adminState());
  }
  if (FACE_REVIEW_HOURS > 0 && minutesSinceReview >= FACE_REVIEW_HOURS * 60) void reviewFace();
}, 60_000);

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
    ws.send(JSON.stringify({ type: "look", look: stylist.current } satisfies ServerToAvatar));
    ws.send(JSON.stringify({ type: "face", params: face.params } satisfies ServerToAvatar));
    ws.on("close", () => avatars.delete(ws));
    ws.on("message", (data) => {
      let msg: AvatarToServer;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "capture-result") captures.get(msg.requestId)?.(msg.images);
      else if (msg.type === "look-failed") log("error", `見た目 ${msg.lookId} の読み込みに失敗: ${msg.error}`);
    });
    return;
  }
  admins.add(ws);
  ws.send(JSON.stringify(adminState()));
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
      case "say":
        await say(msg.text);
        break;
      case "scene":
        stylist.scene = msg.scene;
        log("info", `シーンを「${msg.scene}」に変更`);
        await restyle("scene");
        break;
      case "restyle":
        await restyle("manual");
        break;
      case "wear": {
        const look = stylist.wear(msg.lookId);
        if (look) {
          toAvatars({ type: "look", look });
          log("info", `手動で着替え: ${look.name}`);
        }
        toAdmins(adminState());
        break;
      }
      case "face-review":
        void reviewFace();
        break;
      case "face-rollback": {
        const p = face.rollback();
        if (p) {
          toAvatars({ type: "face", params: p });
          log("warn", `顔を版${p.version}に戻しました`);
          toAdmins(adminState());
        }
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
