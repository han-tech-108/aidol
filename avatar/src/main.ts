import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { Performer } from "./motion.ts";
import { SpeechPlayer } from "./speech.ts";
import type { ServerToAvatar } from "../../server/src/protocol.ts";

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

// ---- モデル ----
let performer: Performer | null = null;
let vrm: VRM | null = null;

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.load(
  modelUrl,
  (gltf) => {
    vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM0.x のモデルもカメラの方を向かせる
    scene.add(vrm.scene);
    performer = new Performer(vrm, camera);
    unlockAudio();
    (window as unknown as { aidolReady: boolean }).aidolReady = true;
  },
  undefined,
  (err) => {
    console.error(err);
    showNotice(`VRM モデルを読み込めませんでした: ${modelUrl}\navatar/public/models/avatar.vrm に VRM ファイルを置いてください`);
  },
);

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
function connect() {
  const ws = new WebSocket(`${serverUrl}/?role=avatar`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerToAvatar;
    if (msg.type === "speak") speech.enqueue(msg);
    else if (msg.type === "stop") {
      speech.stop();
      subtitle.textContent = "";
    } else if (msg.type === "pose") performer?.gesture(msg.gesture);
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();

// 開発用: ブラウザのコンソールから動きを試せるようにする
Object.assign(window, { aidol: { gesture: (g: Parameters<Performer["gesture"]>[0]) => performer?.gesture(g), speech } });

// ---- ループ ----
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  performer?.update(dt, speech.vowel(), speech.level());
  renderer.render(scene, camera);
});
