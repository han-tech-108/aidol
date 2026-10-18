import type { Comment } from "./protocol.ts";

/**
 * YouTube Data API / Analytics API の最小限のクライアント。
 * - API キーだけ: 配信 URL（動画 ID）かチャンネル ID から、チャットと同時視聴者数を読む
 * - OAuth（リフレッシュトークン）: 自分の配信を自動で見つけ、配信後の視聴維持率も読む
 */
export interface YouTubeConfig {
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** 配信の動画 ID（指定がなければ自分・指定チャンネルのライブ中の配信を探す） */
  videoId?: string;
  channelId?: string;
  /** チャットを読みに行く最短間隔（クォータ節約のため） */
  chatPollMs?: number;
}

export function youtubeConfigFromEnv(env = process.env): YouTubeConfig | null {
  const c: YouTubeConfig = {
    apiKey: env.YOUTUBE_API_KEY || undefined,
    clientId: env.YOUTUBE_CLIENT_ID || undefined,
    clientSecret: env.YOUTUBE_CLIENT_SECRET || undefined,
    refreshToken: env.YOUTUBE_REFRESH_TOKEN || undefined,
    videoId: env.YOUTUBE_VIDEO_ID || undefined,
    channelId: env.YOUTUBE_CHANNEL_ID || undefined,
    chatPollMs: Number(env.YOUTUBE_CHAT_POLL_MS ?? 10_000),
  };
  return c.apiKey || c.refreshToken ? c : null;
}

export interface LiveVideo {
  videoId: string;
  liveChatId: string | null;
  concurrentViewers: number | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
  durationSeconds: number | null;
}

export interface ChatItem {
  id: string;
  type: string;
  author: string;
  text: string;
  /** 投げ銭・メンバー加入などの説明（例: スーパーチャット ¥500） */
  gift?: string;
}

const API = "https://www.googleapis.com/youtube/v3";

export class YouTubeClient {
  private accessToken: { value: string; expires: number } | null = null;

  constructor(
    readonly config: YouTubeConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get hasOAuth() {
    return !!(this.config.refreshToken && this.config.clientId && this.config.clientSecret);
  }

  private async token(): Promise<string | null> {
    if (!this.hasOAuth) return null;
    if (this.accessToken && this.accessToken.expires > Date.now() + 60_000) return this.accessToken.value;
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        refresh_token: this.config.refreshToken!,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`YouTube の認証に失敗しました (${res.status}): ${await res.text()}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async get<T>(url: string, params: Record<string, string>): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const token = await this.token();
    if (!token && this.config.apiKey) u.searchParams.set("key", this.config.apiKey);
    const res = await this.fetchImpl(u, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`YouTube API ${u.pathname} が失敗しました (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** 今ライブ中の配信の動画 ID を探す */
  async findLiveVideoId(): Promise<string | null> {
    if (this.config.videoId) return this.config.videoId;
    if (this.hasOAuth) {
      const r = await this.get<{ items?: { id: string }[] }>(`${API}/liveBroadcasts`, { part: "id", broadcastStatus: "active", broadcastType: "all" });
      return r.items?.[0]?.id ?? null;
    }
    if (this.config.channelId) {
      // search は1回100ユニットと重いので、見つかるまでの間だけ使う
      const r = await this.get<{ items?: { id: { videoId: string } }[] }>(`${API}/search`, {
        part: "id",
        channelId: this.config.channelId,
        eventType: "live",
        type: "video",
      });
      return r.items?.[0]?.id.videoId ?? null;
    }
    return null;
  }

  async video(videoId: string): Promise<LiveVideo | null> {
    const r = await this.get<{
      items?: {
        id: string;
        contentDetails?: { duration?: string };
        liveStreamingDetails?: { activeLiveChatId?: string; concurrentViewers?: string; actualStartTime?: string; actualEndTime?: string };
      }[];
    }>(`${API}/videos`, { part: "liveStreamingDetails,contentDetails", id: videoId });
    const v = r.items?.[0];
    if (!v) return null;
    const d = v.liveStreamingDetails ?? {};
    return {
      videoId: v.id,
      liveChatId: d.activeLiveChatId ?? null,
      concurrentViewers: d.concurrentViewers === undefined ? null : Number(d.concurrentViewers),
      actualStartTime: d.actualStartTime ?? null,
      actualEndTime: d.actualEndTime ?? null,
      durationSeconds: parseDuration(v.contentDetails?.duration),
    };
  }

  async chat(liveChatId: string, pageToken?: string) {
    const r = await this.get<{
      nextPageToken?: string;
      pollingIntervalMillis?: number;
      items?: RawChatItem[];
    }>(`${API}/liveChat/messages`, { part: "snippet,authorDetails", liveChatId, maxResults: "200", ...(pageToken ? { pageToken } : {}) });
    return { items: (r.items ?? []).map(toChatItem).filter((x): x is ChatItem => !!x), nextPageToken: r.nextPageToken, pollingIntervalMillis: r.pollingIntervalMillis ?? 5000 };
  }

  /**
   * アーカイブの視聴維持率（動画の経過割合ごとの視聴率）。
   * OAuth（yt-analytics.readonly）が必要。集計には配信後1〜2日かかる。
   */
  async retention(videoId: string, publishedDate: string): Promise<{ ratio: number; watch: number }[]> {
    const r = await this.get<{ rows?: [number, number][] }>("https://youtubeanalytics.googleapis.com/v2/reports", {
      ids: "channel==MINE",
      startDate: publishedDate.slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
      metrics: "audienceWatchRatio",
      dimensions: "elapsedVideoTimeRatio",
      filters: `video==${videoId}`,
    });
    return (r.rows ?? []).map(([ratio, watch]) => ({ ratio, watch }));
  }
}

interface RawChatItem {
  id: string;
  snippet: {
    type: string;
    displayMessage?: string;
    superChatDetails?: { amountDisplayString?: string; userComment?: string };
    superStickerDetails?: { amountDisplayString?: string };
    membershipGiftingDetails?: { giftMembershipsCount?: number };
    memberMilestoneChatDetails?: { memberMonth?: number; userComment?: string };
  };
  authorDetails?: { displayName?: string };
}

/** チャットの1件を、返事に使う形にする。システムメッセージなどは捨てる。 */
export function toChatItem(m: RawChatItem): ChatItem | null {
  const s = m.snippet;
  const author = m.authorDetails?.displayName ?? "名無し";
  const base = { id: m.id, type: s.type, author };
  switch (s.type) {
    case "textMessageEvent":
      return s.displayMessage ? { ...base, text: s.displayMessage } : null;
    case "superChatEvent":
      return { ...base, text: s.superChatDetails?.userComment ?? "", gift: `スーパーチャット ${s.superChatDetails?.amountDisplayString ?? ""}`.trim() };
    case "superStickerEvent":
      return { ...base, text: "", gift: `スーパーステッカー ${s.superStickerDetails?.amountDisplayString ?? ""}`.trim() };
    case "newSponsorEvent":
      return { ...base, text: "", gift: "メンバー加入" };
    case "memberMilestoneChatEvent":
      return { ...base, text: s.memberMilestoneChatDetails?.userComment ?? "", gift: `メンバー継続 ${s.memberMilestoneChatDetails?.memberMonth ?? ""}か月`.trim() };
    case "membershipGiftingEvent":
      return { ...base, text: "", gift: `メンバーシップのギフト ${s.membershipGiftingDetails?.giftMembershipsCount ?? ""}件`.trim() };
    default:
      return null;
  }
}

/** ISO 8601 の期間（PT1H2M3S）を秒にする */
export function parseDuration(d: string | undefined): number | null {
  const m = d && /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  if (!m) return null;
  const [, days, h, mi, s] = m.map((x) => Number(x ?? 0));
  return days! * 86400 + h! * 3600 + mi! * 60 + s!;
}

export interface LiveHandlers {
  onComment(c: Comment): void;
  onVideo(v: LiveVideo): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

/** ライブ中の配信を見つけ、チャットと同時視聴者数を読み続ける。 */
export class YouTubeLive {
  video: LiveVideo | null = null;
  private stopped = false;

  constructor(
    private client: YouTubeClient,
    private h: LiveHandlers,
  ) {}

  get viewers(): number | null {
    return this.video && !this.video.actualEndTime ? this.video.concurrentViewers : null;
  }

  stop() {
    this.stopped = true;
  }

  async start() {
    while (!this.stopped) {
      try {
        const id = await this.client.findLiveVideoId();
        const v = id ? await this.client.video(id) : null;
        if (v?.liveChatId && !v.actualEndTime) {
          this.setVideo(v);
          this.h.log("info", `YouTube の配信 ${v.videoId} につながりました`);
          await Promise.all([this.watchViewers(v.videoId), this.readChat(v.liveChatId)]);
          this.h.log("info", "YouTube の配信が終わりました");
        }
      } catch (e) {
        this.h.log("warn", `YouTube: ${(e as Error).message}`);
      }
      await sleep(this.client.config.videoId ? 30_000 : 120_000);
    }
  }

  private setVideo(v: LiveVideo) {
    this.video = v;
    this.h.onVideo(v);
  }

  private async watchViewers(videoId: string) {
    while (!this.stopped) {
      await sleep(60_000);
      try {
        const v = await this.client.video(videoId);
        if (!v) return;
        this.setVideo(v);
        if (v.actualEndTime) return;
      } catch (e) {
        this.h.log("warn", `YouTube 視聴者数: ${(e as Error).message}`);
      }
    }
  }

  private async readChat(liveChatId: string) {
    let pageToken: string | undefined;
    let first = true;
    const seen = new Set<string>();
    while (!this.stopped && !this.video?.actualEndTime) {
      let wait = this.client.config.chatPollMs ?? 10_000;
      try {
        const r = await this.client.chat(liveChatId, pageToken);
        pageToken = r.nextPageToken;
        wait = Math.max(wait, r.pollingIntervalMillis);
        // つないだ時点より前のコメントには返事をしない
        for (const m of first ? [] : r.items) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          this.h.onComment({ source: "youtube", author: m.author, text: m.text, gift: m.gift });
        }
        if (seen.size > 5000) seen.clear();
        first = false;
      } catch (e) {
        const msg = (e as Error).message;
        this.h.log("warn", `YouTube チャット: ${msg}`);
        if (/\(403\)|\(404\)/.test(msg)) return; // チャット終了・クォータ切れ
        wait = 30_000;
      }
      await sleep(wait);
    }
  }
}

// 待っている間もプロセスの終了を妨げない
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
