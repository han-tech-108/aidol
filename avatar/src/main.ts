import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { DEFAULT_FACE, Performer } from "./motion.ts";
import { SpeechPlayer } from "./speech.ts";
import { EMOTIONS, type AvatarToServer, type CaptureImage, type FaceParams, type ServerToAvatar } from "../../server/src/protocol.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// URL パラメータ
//   transparent=1  背景を透過（OBS 用）
//   layout=vertical 縦型（TikTok 用）の画角
//   subtitles=1    字幕を表示
//   model=URL      VRM ファイルの場所（既定は /models/avatar.vrm）
//   server=URL     サーバーの WebSocket アドレス
const params = new URLSearchParams(location.search);
const vertical = params.get("layout") === "vertical";
if (params.get("transparent") === "1") document.body.classList.add("transparent");
if (params.get("subtitles") === "1") document.body.classList.add("subtitles");
const modelUrl = params.get("model") ?? "/models/avatar.vrm";
const serverUrl = params.get("server") ?? `ws://${location.hostname || "localhost"}:8787`;

const notice = document.getElementById("notice")!;
const subtitle = document.getElementById("subtitle")!;
const showNotice = (text: string) => {
  notice.textContent = text;
  notice.classList.toggle("show", !!text);
};

// ---- 描画 ----
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(vertical ? 32 : 26, 1, 0.1, 20);
camera.position.set(0, vertical ? 1.15 : 1.32, vertical ? 2.9 : 1.9);
camera.lookAt(0, vertical ? 1.0 : 1.25, 0);

const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
key.position.set(0.6, 1.8, 1.6);
scene.add(key, new THREE.AmbientLight(0xffffff, Math.PI * 0.45));

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---- 音声 ----
const speech = new SpeechPlayer();
const unlockAudio = () => {
  if (speech.ctx.state === "suspended") {
    showNotice("クリックすると音声が有効になります\n（OBS のブラウザソースでは不要です）");
    notice.onclick = async () => {
      await speech.ctx.resume();
      showNotice("");
    };
  }
};

// ---- モデル（見た目の切り替え） ----
let performer: Performer | null = null;
let face: FaceParams = DEFAULT_FACE;
let currentFile = "";
let loadingFile = "";

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
const canvas = renderer.domElement;
canvas.style.transition = "opacity 0.3s";

/** VRM を読み込んで、今のモデルとふわっと入れ替える。 */
async function wear(file: string, lookId = file) {
  if (file === currentFile || file === loadingFile) return;
  loadingFile = file;
  try {
    const gltf = await loader.loadAsync(file);
    if (loadingFile !== file) return; // 読み込み中に別の見た目が指定された
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM0.x のモデルもカメラの方を向かせる

    const old = performer;
    if (old) {
      canvas.style.opacity = "0";
      await sleep(300);
    }
    const next = new Performer(vrm, camera, face);
    if (old) {
      next.setEmotion(old.currentEmotion);
      scene.remove(old.vrm.scene);
      VRMUtils.deepDispose(old.vrm.scene);
    }
    scene.add(vrm.scene);
    performer = next;
    currentFile = file;
    canvas.style.opacity = "1";
    showNotice("");
    unlockAudio();
    (window as unknown as { aidolReady: boolean }).aidolReady = true;
  } catch (err) {
    console.error(err);
    send({ type: "look-failed", lookId, error: String(err) });
    if (!performer) showNotice(`VRM モデルを読み込めませんでした: ${file}\navatar/public/models/ に VRM ファイルを置いてください`);
  } finally {
    if (loadingFile === file) loadingFile = "";
  }
}

// サーバーから見た目の指定が来なければ、既定のモデルを表示する
const fallback = setTimeout(() => void wear(modelUrl), params.has("model") ? 0 : 1500);

/** レビュー用に、感情ごとの顔を撮影する。 */
async function captureFaces(): Promise<CaptureImage[]> {
  const p = performer;
  if (!p) return [];
  const before = p.currentEmotion;
  const images: CaptureImage[] = [];
  const crop = document.createElement("canvas");
  crop.width = crop.height = 512;
  const ctx = crop.getContext("2d")!;
  for (const emotion of EMOTIONS) {
    p.setEmotion(emotion);
    await sleep(900);
    renderer.render(scene, camera);
    // 頭の位置を中心に正方形で切り出す
    const head = p.vrm.humanoid.getNormalizedBoneNode("head")!.getWorldPosition(new THREE.Vector3());
    head.y += 0.06;
    const ndc = head.project(camera);
    const cx = ((ndc.x + 1) / 2) * canvas.width;
    const cy = ((1 - ndc.y) / 2) * canvas.height;
    const size = canvas.height * (vertical ? 0.22 : 0.42);
    ctx.fillStyle = "#8a8fa8";
    ctx.fillRect(0, 0, 512, 512);
    ctx.drawImage(canvas, cx - size / 2, cy - size / 2, size, size, 0, 0, 512, 512);
    images.push({ emotion, png: crop.toDataURL("image/png").split(",")[1]! });
  }
  p.setEmotion(before);
  return images;
}

speech.onStart = (msg) => {
  performer?.setEmotion(msg.emotion);
  for (const g of msg.gestures) performer?.gesture(g);
  subtitle.textContent = msg.text;
};
let idleTimer: ReturnType<typeof setTimeout> | undefined;
speech.onIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!speech.speaking) {
      performer?.setEmotion("neutral");
      subtitle.textContent = "";
    }
  }, 2500);
};

// ---- サーバー接続（切れたら再接続） ----
let socket: WebSocket | null = null;
function send(msg: AvatarToServer) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function connect() {
  const ws = new WebSocket(`${serverUrl}/?role=avatar`);
  socket = ws;
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data) as ServerToAvatar;
    switch (msg.type) {
      case "speak":
        speech.enqueue(msg);
        break;
      case "stop":
        speech.stop();
        subtitle.textContent = "";
        break;
      case "pose":
        performer?.gesture(msg.gesture);
        break;
      case "look":
        if (!params.has("model")) {
          clearTimeout(fallback);
          void wear(msg.look.file, msg.look.id);
        }
        break;
      case "face":
        face = msg.params;
        if (performer) performer.face = face;
        break;
      case "capture":
        send({ type: "capture-result", requestId: msg.requestId, images: await captureFaces() });
        break;
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();

// 開発用: ブラウザのコンソールから動きを試せるようにする
Object.assign(window, { aidol: { gesture: (g: Parameters<Performer["gesture"]>[0]) => performer?.gesture(g), speech, captureFaces } });

// ---- ループ ----
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  performer?.update(dt, speech.vowel(), speech.level());
  renderer.render(scene, camera);
});
