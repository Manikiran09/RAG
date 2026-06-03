"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  Activity, ArrowRight, Bot, Loader2, MessageSquare,
  Play, Send, Sparkles, CheckCircle2, AlertCircle,
} from "lucide-react";

type VideoMetadata = {
  videoId: "A" | "B";
  url: string;
  platform: string;
  title: string;
  creator: string;
  followerCount: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  hashtags: string[];
  uploadDate: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  transcriptSource: string;
  engagementRate: number | null;
  extractionWarnings: string[];
};

type AnalyzeResponse = {
  sessionId: string;
  videos: [VideoMetadata, VideoMetadata];
  chunkCount: number;
  vectorProvider: string;
  llmProvider: string;
};

type ChatMessage = { role: "user" | "assistant"; content: string };

const STARTERS = [
  "Why did Video A get more engagement than Video B?",
  "What's the engagement rate of each?",
  "Compare the hooks in the first 5 seconds.",
  "Who's the creator of Video B and what's their follower count?",
  "Suggest improvements for B based on what worked in A.",
];

function fmt(n: number | null): string {
  if (n == null) return "";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function fmtDuration(s: number | null): string {
  if (s == null) return "";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

type MetricBoxProps = {
  label: string;
  value: string | null;
  note: string;
  estimated?: boolean;
};

function MetricBox({ label, value, note, estimated }: MetricBoxProps) {
  const missing = !value;
  return (
    <div className={estimated ? "estimated" : ""}>
      <span>{label}</span>
      <b className={missing ? "unavailable" : ""}>{value ?? "API required"}</b>
      <small>{note}</small>
    </div>
  );
}

function VideoCard({ video }: { video: VideoMetadata }) {
  const goodTranscript = video.transcriptSource === "youtube-transcript-api" || video.transcriptSource === "yt-dlp captions";
  return (
    <section className="video-card">
      <div className="thumb">
        {video.thumbnailUrl
          ? <img src={video.thumbnailUrl} alt="" />
          : <Play size={40} />}
        <span>{video.platform}</span>
      </div>
      <div className="card-body">
        <div className="card-topline">
          <strong>Video {video.videoId}</strong>
          <a href={video.url} target="_blank" rel="noreferrer">
            Open <ArrowRight size={13} />
          </a>
        </div>
        <h2 title={video.title}>{video.title}</h2>
        <p>{video.creator}</p>

        <div className="metrics">
          <MetricBox
            label="Engagement"
            value={video.engagementRate != null ? `${video.engagementRate}%` : null}
            note={video.engagementRate != null ? "Calculated" : "Needs views+likes"}
          />
          <MetricBox
            label="Views"
            value={video.views != null ? fmt(video.views) : null}
            note={video.views != null ? "Extracted" : "Not public"}
          />
          <MetricBox
            label="Likes"
            value={video.likes != null ? fmt(video.likes) : null}
            note={video.likes != null ? "Extracted" : "Not public"}
          />
          <MetricBox
            label="Comments"
            value={video.comments != null ? fmt(video.comments) : null}
            note={video.comments != null ? "Extracted" : "Not public"}
          />
          <MetricBox
            label="Followers"
            value={video.followerCount != null ? fmt(video.followerCount) : null}
            note={video.followerCount != null ? "Extracted" : "Creator API needed"}
          />
          <MetricBox
            label="Duration"
            value={video.durationSeconds != null ? fmtDuration(video.durationSeconds) : null}
            note={video.durationSeconds != null ? "Extracted" : "Not public"}
          />
          <MetricBox
            label="Upload date"
            value={video.uploadDate}
            note={video.uploadDate ? "Extracted" : "Not public"}
          />
        </div>

        <div className="tags">
          {video.hashtags.length
            ? video.hashtags.slice(0, 8).map((t) => <span key={t}>{t}</span>)
            : <span className="no-tags">No hashtags found</span>}
        </div>

        {video.extractionWarnings.length > 0 && (
          <div className="warnings">
            {video.extractionWarnings.map((w) => <p key={w}>{w}</p>)}
          </div>
        )}

        <div className={`transcript-source ${goodTranscript ? "good" : ""}`}>
          {goodTranscript ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          Transcript: {video.transcriptSource}
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [instagramUrl, setInstagramUrl] = useState("");
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState(STARTERS[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);

  const canChat = Boolean(analysis?.sessionId && !streaming);
  const status = useMemo(() => {
    if (!analysis) return "Awaiting URLs";
    return `${analysis.chunkCount} chunks indexed · ${analysis.vectorProvider} · ${analysis.llmProvider}`;
  }, [analysis]);

  async function analyze(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    setMessages([]);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl, instagramUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Analysis failed");
      setAnalysis(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  async function ask(question = input) {
    if (!analysis?.sessionId || !question.trim()) return;
    const userMsg: ChatMessage = { role: "user", content: question.trim() };
    const assistantMsg: ChatMessage = { role: "assistant", content: "" };
    setMessages((c) => [...c, userMsg, assistantMsg]);
    setInput("");
    setStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: analysis.sessionId, message: userMsg.content }),
      });
      if (!res.ok || !res.body) throw new Error("Chat request failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let content = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
        setMessages((c) => c.map((m, i) => i === c.length - 1 ? { ...m, content } : m));
      }
    } catch (err) {
      const content = err instanceof Error ? err.message : "Chat failed";
      setMessages((c) => c.map((m, i) => i === c.length - 1 ? { ...m, content } : m));
    } finally {
      setStreaming(false);
    }
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Full-stack RAG demo · Gemini + LangChain</p>
          <h1>Creator Video Comparator</h1>
        </div>
        <div className="status">
          <Activity size={16} />
          <span>{status}</span>
        </div>
      </header>

      <form className="url-form" onSubmit={analyze}>
        <label>
          <span>YouTube URL</span>
          <input
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            required
          />
        </label>
        <label>
          <span>Instagram Reel URL</span>
          <input
            value={instagramUrl}
            onChange={(e) => setInstagramUrl(e.target.value)}
            placeholder="https://www.instagram.com/reel/..."
            required
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </form>

      {error && <div className="error">⚠ {error}</div>}

      <section className="workspace">
        <div className="videos">
          {analysis
            ? analysis.videos.map((v) => <VideoCard key={v.videoId} video={v} />)
            : (
              <div className="empty">
                <Bot size={36} />
                <p>
                  Enter one YouTube URL and one Instagram Reel URL to extract metadata,
                  chunk transcripts, build a vector index, and unlock the Gemini-powered RAG chat.
                </p>
              </div>
            )}
        </div>

        <aside className="chat">
          <div className="chat-head">
            <MessageSquare size={16} />
            <strong>RAG Chat</strong>
          </div>
          <div className="questions">
            {STARTERS.map((q) => (
              <button key={q} type="button" disabled={!canChat} onClick={() => ask(q)}>
                {q}
              </button>
            ))}
          </div>
          <div className="messages">
            {messages.length === 0 && (
              <p className="muted">Answers stream from Gemini and cite retrieved chunks by video + chunk number.</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role}`}>
                <span>{m.role === "user" ? "You" : "Gemini"}</span>
                <p>{m.content || "Thinking…"}</p>
              </div>
            ))}
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); ask(); }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!canChat}
              placeholder="Ask about hooks, engagement, creators, or improvements…"
              rows={2}
            />
            <button type="submit" disabled={!canChat || !input.trim()}>
              <Send size={16} />
            </button>
          </form>
        </aside>
      </section>
    </main>
  );
}
