import { GESTURES, type AdminToServer, type ServerToAdmin } from "../../server/src/protocol.ts";

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
