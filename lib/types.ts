import type { Document } from "@langchain/core/documents";
import type { VectorStore } from "@langchain/core/vectorstores";

export type VideoId = "A" | "B";

export type VideoMetadata = {
  videoId: VideoId;
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
  transcript: string;
  transcriptSource: string;
  engagementRate: number | null;
  extractionWarnings: string[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type DemoSession = {
  videos: [VideoMetadata, VideoMetadata];
  vectorStore: VectorStore;
  documents: Document[];
  memory: ChatMessage[];
};
