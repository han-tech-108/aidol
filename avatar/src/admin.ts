import { GESTURES, type AdminState, type AdminToServer, type EvolutionStatus, type ServerToAdmin } from "../../server/src/protocol.ts";

const params = new URLSearchParams(location.search);
const serverUrl = params.get("server") ?? `ws://${location.hostname || "localhost"}:8787`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let ws: WebSocket | null = null;
const send = (msg: AdminToServer) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function connect() {
  ws = new WebSocket(`${serverUrl}/?role=admin`);
  ws.onopen = () => ($("status").textContent = `接続中 ${serverUrl}`);
  ws.onclose = () => {
    $("status").textContent = "未接続（再接続しています）";
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerToAdmin;
    if (msg.type === "state") return renderState(msg);
    const line = document.createElement("div");
    line.className = msg.level;
    line.textContent = `${new Date(msg.at).toLocaleTimeString()} ${msg.message}`;
    $("log").prepend(line);
  };
}
connect();

$("comment").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $<HTMLInputElement>("text");
  send({ type: "comment", author: $<HTMLInputElement>("author").value, text: text.value });
  text.value = "";
});
$("say").addEventListener("submit", (e) => {
  e.preventDefault();
  send({ type: "say", text: $<HTMLTextAreaElement>("line").value });
});
$("stop").addEventListener("click", () => send({ type: "stop" }));

for (const g of GESTURES) {
  const b = document.createElement("button");
  b.textContent = g;
  b.onclick = () => send({ type: "gesture", gesture: g });
  $("gestures").appendChild(b);
}

function renderState(st: AdminState) {
  const scene = $<HTMLSelectElement>("scene");
  scene.replaceChildren(...st.scenes.map((name) => new Option(name, name, false, name === st.scene)));
  $("look-now").textContent = `いま: ${st.look.name}`;
  $("looks").replaceChildren(
    ...st.looks.map((l) => {
      const b = document.createElement("button");
      b.className = `look${l.id === st.look.id ? " current" : ""}${l.available ? "" : " missing"}${l.generated ? " generated" : ""}`;
      b.textContent = l.available ? l.name : `${l.name}（VRM未配置）`;
      b.title = `${l.outfit} / ${l.hair}${l.generated ? `\nAIが制作: ${l.generated.rationale}` : ""}`;
      b.disabled = !l.available;
      b.onclick = () => send({ type: "wear", lookId: l.id });
      return b;
    }),
  );
  renderEvolution(st.evolution);
}

let paused = false;

function renderEvolution(evo: EvolutionStatus) {
  paused = evo.paused;
  const testing = evo.active ? `「${evo.domains.find((d) => d.id === evo.active!.domain)?.label}」の版${evo.active.candidate}を試験中` : "試験中の変更なし";
  $("evo-summary").textContent = `${evo.paused ? "一時停止中" : "動作中"}・配信${evo.liveMinutes}分・${testing}`;
  $("evo-pause").textContent = evo.paused ? "再開" : "一時停止";
  $("domains").replaceChildren(
    ...evo.domains.map((d) => {
      const tr = document.createElement("tr");
      if (evo.active?.domain === d.id) tr.className = "testing";
      const cell = (text: string, cls = "") => {
        const td = document.createElement("td");
        td.textContent = text;
        td.className = cls;
        return td;
      };
      const button = (label: string, msg: AdminToServer) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = () => send(msg);
        return b;
      };
      const actions = document.createElement("td");
      actions.className = "row";
      actions.append(
        button("今すぐ改善", { type: "evolve", domain: d.id }),
        button("1つ前に戻す", { type: "revert", domain: d.id }),
        button(d.frozen ? "固定を解除" : "固定する", { type: "freeze", domain: d.id, frozen: !d.frozen }),
      );
      tr.append(cell(d.label), cell(`版${d.version}${d.frozen ? "（固定）" : ""}`), cell(d.rationale, "why"), actions);
      return tr;
    }),
  );
}

$("scene").addEventListener("change", (e) => send({ type: "scene", scene: (e.target as HTMLSelectElement).value }));
$("restyle").addEventListener("click", () => send({ type: "restyle" }));
$("evo-pause").addEventListener("click", () => send({ type: "pause-evolution", paused: !paused }));
$("design").addEventListener("click", () => send({ type: "design" }));
