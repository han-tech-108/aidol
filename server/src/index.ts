import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Brain } from "./llm.ts";
import { MODEL } from "./ai.ts";
import { VoicevoxClient, type VoiceParams } from "./tts.ts";
import { buildSystemPrompt, loadCharacter, type Persona } from "./character.ts";
import { containsNgWord } from "./filter.ts";
import { parseTags, SentenceSplitter } from "./tags.ts";
import { Stylist, type StyleTrigger, type Wardrobe } from "./stylist.ts";
import { readJson } from "./store.ts";
import { Metrics } from "./evolution/metrics.ts";
import { EvolutionEngine } from "./evolution/engine.ts";
import { personaDomain, type Exchange } from "./evolution/domains/persona.ts";
import { DEFAULT_VOICE, voiceDomain } from "./evolution/domains/voice.ts";
import { faceDomain } from "./evolution/domains/face.ts";
import { DEFAULT_MOTION, motionDomain } from "./evolution/domains/motion.ts";
import { DEFAULT_MODEL, modelDomain, modelEdits, type ModelParams } from "./evolution/domains/model.ts";
import { ModelBuilder, mergeEdits } from "./assets/builder.ts";
import { Designer } from "./assets/designer.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { YouTubeClient, YouTubeLive, youtubeConfigFromEnv } from "./youtube.ts";
import type {
  AdminState,
  AdminToServer,
  AvatarToServer,
  CaptureImage,
  Comment,
  Emotion,
  FaceParams,
  Look,
  MotionParams,
  ServerToAdmin,
  ServerToAvatar,
  SpeakMessage,
} from "./protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const MAX_PENDING = 5;
const ROOT = path.join(here, "../..");
const DATA = path.join(ROOT, "data");
const GENERATED = path.join(DATA, "generated");
/** 新しい衣装・髪型を企画する間隔（配信時間・分） */
const DESIGN_INTERVAL = Number(process.env.DESIGN_INTERVAL_MINUTES ?? 240);

// ---- キャラクター・見た目・声 ----
const { constitution, persona: initialPersona } = loadCharacter(path.join(ROOT, "config/character.json"));
const brain = new Brain(buildSystemPrompt(constitution, initialPersona), MODEL, (process.env.CLAUDE_EFFORT ?? "low") as "low");
const metrics = new Metrics(path.join(DATA, "metrics.json"));
const wardrobe = readJson<Wardrobe>(path.join(ROOT, "config/wardrobe.json"), { defaultLook: "", minMinutesBetweenChanges: 10, scenes: [], looks: [] });
const builder = new ModelBuilder(path.join(ROOT, "avatar/public"), GENERATED);
const designer = new Designer({
  file: path.join(DATA, "wardrobe-generated.json"),
  briefsFile: path.join(DATA, "creation-briefs.md"),
  wishlistFile: path.join(DATA, "wishlist.md"),
  outDir: GENERATED,
  builder,
  metrics,
  baseLooks: () => wardrobe.looks,
  generatorCmd: process.env.MODEL_GENERATOR_CMD,
});
const stylist = new Stylist(
  wardrobe,
  () => [...wardrobe.looks, ...designer.looks],
  (look) => builder.exists(look.file),
  metrics,
  path.join(DATA, "wishlist.md"),
);
const tts = new VoicevoxClient(process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021", {
  speaker: Number(process.env.VOICEVOX_SPEAKER ?? 1),
  ...DEFAULT_VOICE,
});

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
designer.onLog = log;

// ---- 自己改善エンジン ----
const transcript: Exchange[] = [];
let motion: MotionParams = DEFAULT_MOTION;
let face: FaceParams;
let model: ModelParams = DEFAULT_MODEL;

const engine = new EvolutionEngine(path.join(DATA, "evolution"), metrics, () => stylist.current.id);
engine.register(
  personaDomain({
    initial: initialPersona,
    constitution,
    transcript: () => transcript,
    apply: (p: Persona) => brain.setSystem(buildSystemPrompt(constitution, p)),
  }),
);
engine.register(voiceDomain({ initial: tts.params, styles: () => tts.styles(), apply: (v: VoiceParams) => (tts.params = v) }));
engine.register(
  faceDomain({
    initial: readJson<FaceParams>(path.join(ROOT, "config/face.json"), {} as FaceParams),
    capture: () => capture(),
    apply: (f) => {
      face = f;
      toAvatars({ type: "face", params: f });
    },
  }),
);
engine.register(
  motionDomain({
    initial: DEFAULT_MOTION,
    apply: (m) => {
      motion = m;
      toAvatars({ type: "motion", params: m });
    },
  }),
);
engine.register(
  modelDomain({
    initial: DEFAULT_MODEL,
    capture: () => capture(),
    apply: (m) => {
      model = m;
      if (avatars.size) toAvatars({ type: "look", look: resolveLook(stylist.current) });
    },
    onSuggestions: (items) => {
      mkdirSync(DATA, { recursive: true });
      appendFileSync(path.join(DATA, "creation-briefs.md"), `\n## ${new Date().toISOString()} モデルの形の改善（AI のレビューより）\n${items.map((s) => `- ${s}`).join("\n")}\n`);
      log("info", `モデルの形の改善点 ${items.length}件を制作指示書に追加しました`);
    },
  }),
);
engine.onEvent = (e) => {
  log(e.kind === "error" ? "error" : e.kind === "reverted" ? "warn" : "info", `自己改善[${e.domain}] ${e.message}`);
  toAdmins(adminState());
};

/** 見た目にモデルの調整をかけた、実際に読み込むファイルを決める */
function resolveLook(look: Look): Look {
  const source = look.generated?.source ?? look.file;
  const edits = mergeEdits(look.generated?.edits, modelEdits(model));
  try {
    return { ...look, file: builder.build(source, edits) };
  } catch (e) {
    log("error", `見た目のファイルを作れませんでした: ${(e as Error).message}`);
    return look;
  }
}

function adminState(): AdminState {
  const available = new Set(stylist.available().map((l) => l.id));
  return {
    type: "state",
    scene: stylist.scene,
    scenes: wardrobe.scenes,
    look: stylist.current,
    looks: [...wardrobe.looks, ...designer.looks].map((l) => ({ ...l, available: available.has(l.id) })),
    evolution: engine.status(),
    youtube: youtube ? { videoId: youtube.video?.videoId ?? null, viewers: youtube.viewers } : null,
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
  if (c.gift) metrics.observeGift(engine.activeVersions());
  if (containsNgWord(c.text, constitution.ngWords) || containsNgWord(c.author, constitution.ngWords)) {
    log("warn", `NGワードを含むコメントを除外: ${c.author}`);
    return;
  }
  if (c.text && metrics.observe(c, engine.activeVersions())) scheduleRestyle();
  // スーパーチャット・メンバー加入へのお礼は、普通のコメントより先に・必ず返す
  if (c.gift) pending.splice(pending.filter((p) => p.gift).length, 0, c);
  else pending.push(c);
  while (pending.length > MAX_PENDING) {
    const i = pending.findIndex((p) => !p.gift);
    if (i < 0) break;
    pending.splice(i, 1);
  }
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
  log("info", `コメント (${c.source}) ${c.author}${c.gift ? ` [${c.gift}]` : ""}: ${c.text}`);

  const gift = c.gift ? ` gift="${escapeAttr(c.gift)}"` : "";
  const userContent = `<comment author="${escapeAttr(c.author)}"${gift}>${escapeText(c.text)}</comment>`;
  const splitter = new SentenceSplitter();
  let emotion: Emotion = "neutral";
  let index = 0;
  let spoken = "";
  // 文ごとに音声合成し、届いた順にアバターへ送る
  let chain = Promise.resolve();

  const handle = (raw: string) => {
    const s = parseTags(raw);
    if (!s.text) return;
    if (containsNgWord(s.text, constitution.ngWords)) {
      log("error", `生成文にNGワードがあったため発話を中止: ${s.text}`);
      controller.abort();
      return;
    }
    emotion = s.emotion ?? emotion;
    spoken += s.text;
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
    if (controller.signal.aborted) brain.remember(userContent, spoken);
    else log("error", `応答の生成に失敗: ${(e as Error).message}`);
  }
  await chain;
  if (spoken) {
    transcript.push({ at: new Date().toISOString(), comment: `${c.author}: ${c.text}`, reply: spoken });
    if (transcript.length > 100) transcript.shift();
  }
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

function wearNow(look: Look) {
  toAvatars({ type: "look", look: resolveLook(look) });
}

async function restyle(trigger: StyleTrigger) {
  try {
    const d = await stylist.decide(trigger);
    if (!d) return;
    log("info", `スタイリスト: ${d.look.name}（${d.reason}）`);
    if (d.changed) {
      wearNow(d.look);
      await say(d.line);
    }
    toAdmins(adminState());
  } catch (e) {
    log("error", `見た目の選択に失敗: ${(e as Error).message}`);
  }
}

async function designNewLook() {
  try {
    const look = await designer.design(engine.status().liveMinutes);
    if (look) {
      log("info", `新しい見た目「${look.name}」を作りました: ${look.generated?.rationale ?? ""}`);
      toAdmins(adminState());
    }
  } catch (e) {
    log("error", `新しい見た目の制作に失敗: ${(e as Error).message}`);
  }
}

// ---- 顔の撮影（表情・モデルの改善に使う） ----
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
      captures.delete(requestId);
      resolve(images);
    });
    ws.send(JSON.stringify({ type: "capture", requestId } satisfies ServerToAvatar));
  });
}

// ---- 配信中は1分ごとに記録と自己改善を進める ----
setInterval(async () => {
  if (!avatars.size) return;
  metrics.tick(engine.activeVersions(), 1, youtube?.viewers ?? null);
  await engine.tick();
  for (const l of designer.evaluate(stylist.available().filter((x) => !x.generated))) {
    log("warn", `反応が良くなかったので「${l.name}」を引退させました`);
    if (stylist.current.id === l.id) void restyle("manual");
  }
  if (!engine.status().paused && designer.due(engine.status().liveMinutes, DESIGN_INTERVAL)) await designNewLook();
}, 60_000);

function escapeAttr(s: string) {
  return s.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
function escapeText(s: string) {
  return s.replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// ---- YouTube：コメントと視聴データ ----
const ytConfig = youtubeConfigFromEnv();
const ytClient = ytConfig ? new YouTubeClient(ytConfig) : null;
const youtube = ytClient
  ? new YouTubeLive(ytClient, {
      onComment: enqueue,
      onVideo: (v) => {
        if (v.actualStartTime) metrics.startSession(v.videoId, v.actualStartTime, engine.activeVersions());
        toAdmins(adminState());
      },
      log,
    })
  : null;

/** 配信が終わって集計が出たら、アーカイブの視聴維持率を版ごとに振り分ける */
async function collectRetention() {
  if (!ytClient?.hasOAuth) return;
  for (const s of metrics.pendingSessions()) {
    try {
      const v = await ytClient.video(s.videoId);
      if (!v) {
        metrics.addRetention(s.videoId, [], 0);
        continue;
      }
      const endedHoursAgo = v.actualEndTime ? (Date.now() - Date.parse(v.actualEndTime)) / 3_600_000 : 0;
      if (!v.actualEndTime || endedHoursAgo < 48 || !v.durationSeconds) continue; // 集計が出るまで待つ
      const curve = await ytClient.retention(s.videoId, s.startedAt);
      if (curve.length || endedHoursAgo > 24 * 7) {
        metrics.addRetention(s.videoId, curve, v.durationSeconds);
        log("info", `配信 ${s.videoId} の視聴維持率を取り込みました（${curve.length}点）`);
      }
    } catch (e) {
      log("warn", `視聴維持率の取得に失敗: ${(e as Error).message}`);
    }
  }
}
setInterval(() => void collectRetention(), 6 * 3_600_000);

// ---- サーバー ----
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, avatars: avatars.size, tts: ttsAvailable }));
    return;
  }
  // AI が作った VRM を配信する
  const m = /^\/generated\/([\w-]+\.vrm)$/.exec(url.pathname);
  if (m && existsSync(path.join(GENERATED, m[1]!))) {
    res.writeHead(200, { "Content-Type": "model/gltf-binary", "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=31536000, immutable" });
    createReadStream(path.join(GENERATED, m[1]!)).pipe(res);
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
    ws.send(JSON.stringify({ type: "look", look: resolveLook(stylist.current) } satisfies ServerToAvatar));
    ws.send(JSON.stringify({ type: "face", params: face } satisfies ServerToAvatar));
    ws.send(JSON.stringify({ type: "motion", params: motion } satisfies ServerToAvatar));
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
      case "gesture":
        toAvatars({ type: "pose", gesture: msg.gesture });
        break;
      case "stop":
        stopAll();
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
          wearNow(look);
          log("info", `手動で着替え: ${look.name}`);
        }
        toAdmins(adminState());
        break;
      }
      case "design":
        await designNewLook();
        break;
      case "evolve":
        await engine.runNow(msg.domain);
        break;
      case "revert":
        await engine.revert(msg.domain);
        break;
      case "freeze":
        engine.setFrozen(msg.domain, msg.frozen);
        toAdmins(adminState());
        break;
      case "pause-evolution":
        engine.setPaused(msg.paused);
        log("warn", msg.paused ? "自己改善を一時停止しました" : "自己改善を再開しました");
        toAdmins(adminState());
        break;
    }
  });
});

http.listen(PORT, async () => {
  await engine.applyAll();
  ttsAvailable = await tts.isAvailable();
  console.log(`aidol server: ws://localhost:${PORT}`);
  console.log(ttsAvailable ? "VOICEVOX に接続しました" : "VOICEVOX が見つからないため、音声なし（口パクのみ）で動作します");
  if (youtube) {
    void youtube.start();
    void collectRetention();
    console.log(ytClient!.hasOAuth ? "YouTube（OAuth）: 自分のライブ配信を探します" : "YouTube（API キー）: 指定の配信を探します");
  }
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY が未設定です。.env に設定してください");
});
