import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { YoutubeTranscript } from "youtube-transcript";
import type { VideoId, VideoMetadata } from "./types";

const execFileAsync = promisify(execFile);

type YtDlpInfo = {
  [key: string]: any;
  title?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  channel_follower_count?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  tags?: string[];
  upload_date?: string;
  timestamp?: number;
  duration?: number;
  thumbnail?: string;
  description?: string;
  webpage_url?: string;
  subtitles?: Record<string, CaptionTrack[]>;
  automatic_captions?: Record<string, CaptionTrack[]>;
};

type CaptionTrack = {
  url?: string;
  ext?: string;
  name?: string;
};

function inferPlatform(url: string): VideoMetadata["platform"] {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "YouTube";
  if (lower.includes("instagram.com")) return "Instagram";
  return "Unknown";
}

function formatUploadDate(info: YtDlpInfo): string | null {
  if (info.upload_date && /^\d{8}$/.test(info.upload_date)) {
    return `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6)}`;
  }
  if (info.timestamp) return new Date(info.timestamp * 1000).toISOString().slice(0, 10);
  return null;
}

function extractHashtags(...texts: Array<string | undefined>): string[] {
  const tags = new Set<string>();
  for (const text of texts) {
    for (const match of text?.matchAll(/#[\p{L}\p{N}_]+/gu) ?? []) {
      tags.add(match[0]);
    }
  }
  return [...tags].slice(0, 20);
}

function engagementRate(likes: number | null, comments: number | null, views: number | null): number | null {
  if (!views || likes == null || comments == null) return null;
  return Number((((likes + comments) / views) * 100).toFixed(3));
}

function parseCount(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([kmb])?/) ?? normalized.match(/(\d+)/);
  if (!match) return null;
  const number = Number(match[1]);
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
  return Math.round(number * multiplier);
}

function pickNumber(source: Record<string, any> | null | undefined, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    const parsed = parseCount(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function searchNestedCount(value: unknown, keyPatterns: RegExp[], depth = 0): number | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string" || typeof value === "number") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = searchNestedCount(item, keyPatterns, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  const object = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(object)) {
    if (keyPatterns.some((pattern) => pattern.test(key))) {
      const direct = parseCount(nested);
      if (direct != null) return direct;
      if (typeof nested === "object") {
        const textValue = (nested as Record<string, unknown>).simpleText ?? (nested as Record<string, unknown>).label;
        const textParsed = parseCount(textValue);
        if (textParsed != null) return textParsed;
      }
    }
  }
  for (const nested of Object.values(object)) {
    const found = searchNestedCount(nested, keyPatterns, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function extractJsonObject(html: string, marker: string): unknown | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf("{", markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      escaped = char === "\\" && !escaped;
      if (char === "\"" && !escaped) inString = false;
      if (char !== "\\") escaped = false;
      continue;
    }
    if (char === "\"") inString = true;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchYouTubePageInfo(url: string): Promise<YtDlpInfo | null> {
  if (inferPlatform(url) !== "YouTube") return null;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 CreatorRAGDemo/1.0",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const player = extractJsonObject(html, "ytInitialPlayerResponse") as Record<string, any> | null;
    const data = extractJsonObject(html, "ytInitialData") as Record<string, any> | null;
    const details = player?.videoDetails ?? {};
    const microformat = player?.microformat?.playerMicroformatRenderer ?? {};
    const secondary = JSON.stringify(data ?? {});
    const views =
      parseCount(details.viewCount) ??
      parseCount(microformat.viewCount) ??
      searchNestedCount(player, [/^viewCount$/i, /viewCountText/i]) ??
      parseCount(html.match(/"viewCount"\s*:\s*"?(\\?\d[\d,]*)"?/i)?.[1]);
    const likes =
      searchNestedCount(data, [/likeCount/i, /likeCountText/i]) ??
      parseCount(secondary.match(/"label":"([^"]*likes?)"/i)?.[1]) ??
      parseCount(html.match(/"likeCount"\s*:\s*"?(\\?\d[\d,]*)"?/i)?.[1]);
    const comments =
      searchNestedCount(data, [/commentCount/i, /commentCountText/i]) ??
      parseCount(secondary.match(/"simpleText":"([^"]*comments?)"/i)?.[1]) ??
      parseCount(html.match(/"commentCount"\s*:\s*"?(\\?\d[\d,]*)"?/i)?.[1]);

    return {
      title: details.title ?? microformat.title?.simpleText,
      uploader: details.author ?? microformat.ownerChannelName,
      channel: details.author ?? microformat.ownerChannelName,
      view_count: views ?? undefined,
      like_count: likes ?? undefined,
      comment_count: comments ?? undefined,
      upload_date: typeof microformat.publishDate === "string" ? microformat.publishDate.replaceAll("-", "") : undefined,
      duration: parseCount(details.lengthSeconds) ?? undefined,
      thumbnail: details.thumbnail?.thumbnails?.at(-1)?.url ?? microformat.thumbnail?.thumbnails?.at(-1)?.url,
      description: details.shortDescription ?? microformat.description?.simpleText,
      tags: details.keywords,
      webpage_url: url,
    };
  } catch {
    return null;
  }
}

async function runYtDlp(url: string): Promise<YtDlpInfo | null> {
  const args = ["--dump-json", "--skip-download", "--no-warnings", url];
  const configuredPath = process.env.YTDLP_PATH?.trim();
  const localBinary = path.join(process.cwd(), "bin", "yt-dlp.exe");
  const commands: Array<[string, string[]]> = [
    ...(configuredPath ? ([[configuredPath, args]] as Array<[string, string[]]>) : []),
    [localBinary, args],
    ["yt-dlp", args],
    ["python", ["-m", "yt_dlp", ...args]],
    ["py", ["-m", "yt_dlp", ...args]],
  ];

  for (const [command, commandArgs] of commands) {
    try {
      const { stdout } = await execFileAsync(command, commandArgs, {
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const firstJsonLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("{"));
      return firstJsonLine ? (JSON.parse(firstJsonLine) as YtDlpInfo) : null;
    } catch {
      // Try the next locally available executable.
    }
  }
  return null;
}

async function fetchCaptionFromTracks(info: YtDlpInfo): Promise<string | null> {
  const trackSets = [info.subtitles, info.automatic_captions];
  for (const tracks of trackSets) {
    const candidates = [
      ...(tracks?.en ?? []),
      ...(tracks?.["en-US"] ?? []),
      ...Object.values(tracks ?? {}).flat(),
    ];
    const track = candidates.find((candidate) => candidate.url && ["vtt", "srv3", "json3", "ttml"].includes(candidate.ext ?? ""));
    if (!track?.url) continue;

    const response = await fetch(track.url);
    if (!response.ok) continue;
    const raw = await response.text();
    return raw
      .replace(/^WEBVTT[\s\S]*?\n\n/, "")
      .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\{.*?\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return null;
}

async function fetchYouTubeTranscript(url: string): Promise<string | null> {
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(url);
    return transcript.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

async function fetchOEmbed(url: string): Promise<Partial<VideoMetadata>> {
  const platform = inferPlatform(url);
  const endpoint =
    platform === "YouTube"
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
      : platform === "Instagram"
        ? `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&omitscript=true`
        : "";
  if (!endpoint) return {};

  try {
    const response = await fetch(endpoint);
    if (!response.ok) return {};
    const data = (await response.json()) as Record<string, string>;
    return {
      title: data.title,
      creator: data.author_name,
      thumbnailUrl: data.thumbnail_url,
    };
  } catch {
    return {};
  }
}

export async function extractVideo(url: string, videoId: VideoId): Promise<VideoMetadata> {
  const warnings: string[] = [];
  const platform = inferPlatform(url);
  const [ytDlpInfo, oEmbed, youtubeTranscript] = await Promise.all([
    runYtDlp(url),
    fetchOEmbed(url),
    platform === "YouTube" ? fetchYouTubeTranscript(url) : Promise.resolve(null),
  ]);
  const pageInfo = ytDlpInfo ?? (await fetchYouTubePageInfo(url));
  const primaryInfo = ytDlpInfo ?? pageInfo;

  if (!ytDlpInfo && pageInfo) {
    warnings.push("yt-dlp was not available, so YouTube public page metadata was parsed as a fallback.");
  } else if (!ytDlpInfo) {
    warnings.push("yt-dlp was not available or could not read this URL; public oEmbed fallback was used.");
  }

  const captionTranscript = primaryInfo ? await fetchCaptionFromTracks(primaryInfo) : null;
  const transcript = youtubeTranscript || captionTranscript || primaryInfo?.description || oEmbed.title || "";
  if (!youtubeTranscript && !captionTranscript) {
    warnings.push("No caption transcript was exposed publicly; description/title text was used as the transcript fallback.");
  }

  const title = primaryInfo?.title || oEmbed.title || `${platform} video`;
  const creator = primaryInfo?.uploader || primaryInfo?.channel || oEmbed.creator || "Unknown creator";
  const likes = pickNumber(primaryInfo, ["like_count", "likes", "likeCount", "edge_media_preview_like"]) ?? null;
  const comments = pickNumber(primaryInfo, ["comment_count", "comments", "commentCount", "edge_media_to_comment"]) ?? null;
  const views =
    pickNumber(primaryInfo, [
      "view_count",
      "views",
      "viewCount",
      "play_count",
      "plays",
      "playCount",
      "video_view_count",
      "videoViewCount",
      "reel_media_view_count",
      "ig_play_count",
    ]) ?? null;
  const followers = pickNumber(primaryInfo, ["channel_follower_count", "follower_count", "followers", "subscriber_count", "subscriberCount"]) ?? null;

  return {
    videoId,
    url,
    platform,
    title,
    creator,
    followerCount: followers,
    views,
    likes,
    comments,
    hashtags: [...new Set([...(primaryInfo?.tags ?? []).filter((tag) => tag.startsWith("#")), ...extractHashtags(primaryInfo?.description, title)])],
    uploadDate: primaryInfo ? formatUploadDate(primaryInfo) : null,
    durationSeconds: primaryInfo?.duration ?? null,
    thumbnailUrl: primaryInfo?.thumbnail || oEmbed.thumbnailUrl || null,
    transcript,
    transcriptSource: youtubeTranscript ? "youtube-transcript-api" : captionTranscript ? "yt-dlp captions" : "metadata fallback",
    engagementRate: engagementRate(likes, comments, views),
    extractionWarnings: warnings,
  };
}
