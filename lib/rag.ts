import { Document } from "@langchain/core/documents";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { LocalHashEmbeddings } from "./localEmbeddings";
import type { ChatMessage, DemoSession, VideoMetadata } from "./types";

export function getProviderLabels() {
  const llmProvider = process.env.GOOGLE_API_KEY?.trim()
    ? `Gemini ${process.env.GEMINI_MODEL || "gemini-1.5-flash"}`
    : process.env.OPENAI_API_KEY?.trim()
      ? "OpenAI GPT-4o-mini"
      : "Local extractive fallback";
  return {
    vectorProvider: "LangChain MemoryVectorStore (local)",
    llmProvider,
  };
}

function getEmbeddings() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey && process.env.OPENAI_EMBEDDINGS === "true") {
    return new OpenAIEmbeddings({ model: "text-embedding-3-small", apiKey });
  }
  return new LocalHashEmbeddings();
}

export async function buildVectorStore(videos: [VideoMetadata, VideoMetadata]) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 900,
    chunkOverlap: 140,
  });

  const documents: Document[] = [];
  for (const video of videos) {
    const sourceText = [
      `Video ${video.videoId}: ${video.title}`,
      `Creator: ${video.creator}`,
      `Platform: ${video.platform}`,
      `Views: ${video.views ?? "unknown"}`,
      `Likes: ${video.likes ?? "unknown"}`,
      `Comments: ${video.comments ?? "unknown"}`,
      `Followers: ${video.followerCount ?? "unknown"}`,
      `Engagement rate: ${video.engagementRate ?? "unknown"}%`,
      `Upload date: ${video.uploadDate ?? "unknown"}`,
      `Duration: ${video.durationSeconds ?? "unknown"}s`,
      `Hashtags: ${video.hashtags.join(", ") || "none"}`,
      `Transcript source: ${video.transcriptSource}`,
      video.transcript,
    ].join("\n");

    const chunks = await splitter.createDocuments([sourceText], [
      {
        video_id: video.videoId,
        source: video.url,
        title: video.title,
        creator: video.creator,
      },
    ]);
    chunks.forEach((chunk, index) => {
      chunk.metadata.chunk_id = `${video.videoId}-${index + 1}`;
      chunk.metadata.chunk_index = index + 1;
      chunk.metadata.citation = `Video ${video.videoId}, chunk ${index + 1}`;
      documents.push(chunk);
    });
  }

  const embeddings = getEmbeddings();
  const vectorStore = await MemoryVectorStore.fromDocuments(documents, embeddings);
  return { vectorStore, documents };
}

function metricLine(video: VideoMetadata): string {
  return [
    `Video ${video.videoId} (${video.platform}): ${video.title}`,
    `creator=${video.creator}`,
    `followers=${video.followerCount ?? "unknown"}`,
    `views=${video.views ?? "unknown"}`,
    `likes=${video.likes ?? "unknown"}`,
    `comments=${video.comments ?? "unknown"}`,
    `engagement_rate=${video.engagementRate ?? "unknown"}%`,
    `upload_date=${video.uploadDate ?? "unknown"}`,
    `duration_seconds=${video.durationSeconds ?? "unknown"}`,
    `hashtags=${video.hashtags.join(", ") || "none found"}`,
    `transcript_source=${video.transcriptSource}`,
  ].join("; ");
}

function firstWords(text: string, count: number) {
  return text.split(/\s+/).filter(Boolean).slice(0, count).join(" ");
}

function buildPrompt(session: DemoSession, question: string, retrieved: Document[]) {
  const metrics = session.videos.map(metricLine).join("\n");
  const context = retrieved
    .map((doc) => `[${doc.metadata.citation}] ${doc.pageContent}`)
    .join("\n\n");
  const hooks = session.videos
    .map((video) => `Video ${video.videoId} approximate opening hook: ${firstWords(video.transcript, 45) || "Unavailable"}`)
    .join("\n");
  const memory = session.memory.slice(-8).map((message) => `${message.role}: ${message.content}`).join("\n");

  return { metrics, context, hooks, memory, question };
}

async function* streamGeminiAnswer(session: DemoSession, question: string, retrieved: Document[]) {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not configured. Add it to your .env.local file.");
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const { metrics, context, hooks, memory } = buildPrompt(session, question, retrieved);
  const prompt = [
    "You are a senior creator analytics engineer answering with RAG.",
    "Use only the provided metrics and retrieved transcript chunks.",
    "Cite claims with source labels like [Video A, chunk 2].",
    "If a metric shows 'unknown', clearly state it is unavailable and explain which API/tool would be needed to obtain it.",
    "Be concise, specific, and action-oriented.",
    "",
    `Metrics:\n${metrics}`,
    `Approximate hooks:\n${hooks}`,
    `Prior chat memory:\n${memory || "None"}`,
    `Retrieved transcript chunks:\n${context}`,
    `Question: ${question}`,
  ].join("\n\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini request failed with ${response.status}`);
  }
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text ?? "")
      .join("") || "";
  // Simulate streaming by yielding in chunks
  for (const token of text.match(/.{1,80}(\s|$)/g) ?? [text]) {
    yield token;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}

async function* streamOpenAIAnswer(session: DemoSession, question: string, retrieved: Document[]) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const { metrics, context, hooks, memory } = buildPrompt(session, question, retrieved);
  const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.2, streaming: true, apiKey });
  const messages = [
    new HumanMessage(
      `You are a senior creator analytics engineer.\nMetrics:\n${metrics}\n\nHooks:\n${hooks}\n\nMemory:\n${memory || "None"}\n\nChunks:\n${context}\n\nQuestion: ${question}`
    ),
  ];
  const stream = await model.stream(messages);
  for await (const chunk of stream) {
    const content = Array.isArray(chunk.content)
      ? chunk.content.map((part) => ("text" in part ? part.text : "")).join("")
      : String(chunk.content ?? "");
    if (content) yield content;
  }
}

function makeFallbackAnswer(session: DemoSession, question: string, retrieved: Document[]) {
  const [a, b] = session.videos;
  const richer =
    a.engagementRate != null && b.engagementRate != null
      ? a.engagementRate >= b.engagementRate
        ? a
        : b
      : null;
  const snippets = retrieved
    .slice(0, 4)
    .map((doc) => `- [${doc.metadata.citation}] ${firstWords(doc.pageContent, 42)}`)
    .join("\n");
  const hookA = firstWords(a.transcript, 35) || "Unavailable";
  const hookB = firstWords(b.transcript, 35) || "Unavailable";

  return [
    `Based on the extracted metadata, Video A has an engagement rate of ${a.engagementRate ?? "unavailable"}% and Video B has ${b.engagementRate ?? "unavailable"}%.`,
    richer
      ? `The stronger engagement signal is Video ${richer.videoId}.`
      : "A full winner call needs public likes, comments, and views for both videos.",
    `Video A creator: ${a.creator}, followers: ${a.followerCount ?? "unavailable"}. Video B creator: ${b.creator}, followers: ${b.followerCount ?? "unavailable"}.`,
    `Video A opens with: "${hookA}". Video B opens with: "${hookB}".`,
    snippets ? `\nSources:\n${snippets}` : "\nSources: no transcript chunks available.",
  ].join("\n\n");
}

export async function getRetrievedDocs(session: DemoSession, question: string) {
  return session.vectorStore.similaritySearch(question, 6);
}

export async function* answerQuestion(session: DemoSession, question: string) {
  const retrieved = await getRetrievedDocs(session, question);
  let full = "";

  if (process.env.GOOGLE_API_KEY?.trim()) {
    try {
      for await (const token of streamGeminiAnswer(session, question, retrieved)) {
        full += token;
        yield token;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const fallback = `⚠️ Gemini error: ${msg}\n\n${makeFallbackAnswer(session, question, retrieved)}`;
      full = fallback;
      yield fallback;
    }
  } else if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      for await (const token of streamOpenAIAnswer(session, question, retrieved)) {
        full += token;
        yield token;
      }
    } catch (error) {
      const fallback = `⚠️ OpenAI unavailable.\n\n${makeFallbackAnswer(session, question, retrieved)}`;
      full = fallback;
      yield fallback;
    }
  } else {
    const fallback = `⚠️ No LLM API key set. Add GOOGLE_API_KEY to .env.local\n\n${makeFallbackAnswer(session, question, retrieved)}`;
    full = fallback;
    for (const token of fallback.match(/.{1,80}(\s|$)/g) ?? [fallback]) {
      yield token;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  session.memory.push({ role: "user", content: question }, { role: "assistant", content: full });
}

export function messagesToLangChain(messages: ChatMessage[]) {
  return messages.map((message) =>
    message.role === "assistant" ? new AIMessage(message.content) : new HumanMessage(message.content)
  );
}
