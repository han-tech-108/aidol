# AIドル

AIがコメントに返事をし、3Dアバター（VRM）が声と身振りで喋るバーチャルアイドルのシステムです。
今はフェーズ1（喋るアバター）まで実装しています。設計の全体像は設計書を参照してください。

```
管理画面 / (将来) YouTube・TikTok のコメント
        │ WebSocket
        ▼
server/  コメント選別 → Claude で返事を生成（文ごとにストリーミング）→ VOICEVOX で音声合成
        │ WebSocket（台詞・感情・動作タグ・音声・口の形のタイミング）
        ▼
avatar/  three-vrm で描画：待機モーション、身振り、表情、口パク、まばたき、視線
        │ ブラウザソース
        ▼
OBS → YouTube / TikTok
```

## 必要なもの

- Node.js 22 以上
- Claude API キー（[Anthropic Console](https://console.anthropic.com) で発行）
- [VOICEVOX](https://voicevox.hiroshiba.jp/)（任意。起動していなければ音声なし・口パクだけで動きます）
- VRM モデル（[VRoid Studio](https://vroid.com/studio) で作って VRM 1.0 で書き出し）

## はじめかた

```bash
npm install
cp .env.example .env          # ANTHROPIC_API_KEY を書き込む
cp ~/Downloads/your.vrm avatar/public/models/avatar.vrm
# VOICEVOX を起動しておく（任意）
npm run dev
```

- アバター: http://localhost:5173/
- 管理画面: http://localhost:5173/admin.html

管理画面からコメントを送ると、アバターが返事をします。「台詞をそのまま言わせる」では AI を通さずに喋らせられます。
赤い「すぐに止める」ボタンで、生成中の返事と再生待ちの台詞をすべて止めます。

## OBS での使い方

ソースに「ブラウザ」を追加し、次の URL を指定します。

| 用途 | URL | サイズ |
| --- | --- | --- |
| YouTube（横型） | `http://localhost:5173/?transparent=1` | 1920×1080 |
| TikTok（縦型） | `http://localhost:5173/?transparent=1&layout=vertical` | 1080×1920 |

「OBS で音声を制御する」にチェックを入れると、アバターの声が配信に乗ります。字幕を出したいときは `&subtitles=1` を付けます。

## 設定

- `config/character.json` … 名前・性格・話し方・守ること・NGワード。サーバーを再起動すると反映されます。
- `.env` … モデル（既定 `claude-opus-5-5`、思考の深さ `low`）、VOICEVOX の URL と話者 ID、ポート。

## AI の返事の形式

AI は各文の先頭に感情タグ、必要なら動作タグを付けて返します。例: `[joy][wave]たろうさん、こんばんは！`

| 種類 | タグ |
| --- | --- |
| 感情（表情） | `neutral` `joy` `fun` `angry` `sorrow` `surprised` |
| 動作 | `wave` `nod` `think` `bow` `cheer` `shake` |

動作は `avatar/src/motion.ts` の `GESTURES` に、ボーンの回転として定義しています。モデルによって見え方が変わるので、管理画面の「動作を試す」ボタンで確認しながら調整してください。

## 開発

```bash
npm run typecheck   # 型チェック
npm test -w server  # サーバーのテスト
```

## 今後（設計書の実装ステップより）

1. フェーズ2: YouTube Live のコメント取得、優先度づけ、配信開始の自動化（obs-websocket）
2. フェーズ3: モーション素材の追加、イベント（スパチャ等）への反応、沈黙時の自発トーク
3. フェーズ4: TikTok LIVE 対応と同時配信
4. フェーズ5: 切り抜き動画の生成と投稿
