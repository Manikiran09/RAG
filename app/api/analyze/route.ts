import { NextRequest, NextResponse } from "next/server";

import { extractVideo } from "../../../lib/extractors";
import { buildVectorStore, getProviderLabels } from "../../../lib/rag";
import { createSessionId, saveSession } from "../../../lib/sessionStore";
import type { VideoMetadata } from "../../../lib/types";

export async function POST(request: NextRequest) {
  let body: { youtubeUrl?: string; instagramUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  try {
    if (!body.youtubeUrl || !body.instagramUrl) {
      return NextResponse.json({ error: "Both youtubeUrl and instagramUrl are required" }, { status: 400 });
    }

    const videos = (await Promise.all([
      extractVideo(body.youtubeUrl, "A"),
      extractVideo(body.instagramUrl, "B"),
    ])) as [VideoMetadata, VideoMetadata];
    const { vectorStore, documents } = await buildVectorStore(videos);
    const sessionId = createSessionId();
    saveSession(sessionId, { videos, vectorStore, documents, memory: [] });
    const providers = getProviderLabels();

    return NextResponse.json({
      sessionId,
      videos,
      chunkCount: documents.length,
      vectorProvider: providers.vectorProvider,
      llmProvider: providers.llmProvider,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 422 },
    );
  }
}