/**
 * YouTube の OAuth リフレッシュトークンを取得する（最初に1回だけ実行）。
 *   npm run youtube-auth -w server
 * .env に YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET を入れてから実行し、
 * 表示された URL をブラウザで開いて配信するチャンネルのアカウントで許可してください。
 */
import { createServer } from "node:http";

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(".env に YOUTUBE_CLIENT_ID と YOUTUBE_CLIENT_SECRET を設定してください");
  process.exit(1);
}
const port = 8788;
const redirectUri = `http://127.0.0.1:${port}/callback`;
const scopes = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];

const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
url.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: scopes.join(" "),
  access_type: "offline",
  prompt: "consent",
}).toString();

const server = createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", redirectUri).searchParams.get("code");
  if (!code) return res.writeHead(404).end();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const j = (await r.json()) as { refresh_token?: string; error?: string };
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(j.refresh_token ? "完了しました。ターミナルに戻ってください。" : `失敗しました: ${j.error}`);
  if (j.refresh_token) console.log(`\n.env に次の行を追加してください:\nYOUTUBE_REFRESH_TOKEN=${j.refresh_token}\n`);
  else console.error("リフレッシュトークンを取得できませんでした:", j);
  server.close();
});
server.listen(port, "127.0.0.1", () => console.log(`このURLをブラウザで開いてください:\n${url}`));
