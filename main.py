from __future__ import annotations

import asyncio
import hashlib
import math
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import yt_dlp
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel, HttpUrl
from youtube_transcript_api import YouTubeTranscriptApi

load_dotenv()

app = FastAPI(title="Creator Video RAG API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    youtubeUrl: HttpUrl
    instagramUrl: HttpUrl


class ChatRequest(BaseModel):
    sessionId: str
    message: str


VideoId = Literal["A", "B"]


class LocalHashEmbeddings(Embeddings):
    dimensions = 384

    def _embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        tokens = re.findall(r"[a-z0-9#@]+", text.lower())
        for token in tokens:
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimensions
            sign = 1 if digest[4] % 2 else -1
            vector[index] += sign * (1 + min(len(token), 12) / 12)
        norm = math.sqrt(sum(value * value for value in vector)) or 1
        return [value / norm for value in vector]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


@dataclass
class Session:
    videos: list[dict[str, Any]]
    vector_store: Chroma
    documents: list[Document]
    memory: list[dict[str, str]] = field(default_factory=list)


sessions: dict[str, Session] = {}


def platform(url: str) -> str:
    lower = url.lower()
    if "youtube.com" in lower or "youtu.be" in lower:
        return "YouTube"
    if "instagram.com" in lower:
        return "Instagram"
    return "Unknown"


def engagement(likes: int | None, comments: int | None, views: int | None) -> float | None:
    if not views or likes is None or comments is None:
        return None
    return round(((likes + comments) / views) * 100, 3)


def hashtags(*texts: str | None) -> list[str]:
    found: list[str] = []
    for text in texts:
        for tag in re.findall(r"#[\w]+", text or ""):
            if tag not in found:
                found.append(tag)
    return found[:20]


def video_id_from_youtube(url: str) -> str:
    patterns = [r"v=([^&]+)", r"youtu\.be/([^?]+)", r"shorts/([^?]+)"]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return url


async def transcript_for(url: str, info: dict[str, Any], source_platform: str) -> tuple[str, str, list[str]]:
    warnings: list[str] = []
    if source_platform == "YouTube":
        try:
            items = await asyncio.to_thread(YouTubeTranscriptApi.get_transcript, video_id_from_youtube(url))
            return " ".join(item["text"] for item in items), "youtube-transcript-api", warnings
        except Exception:
            warnings.append("YouTube transcript API did not expose captions for this URL.")

    requested = info.get("requested_subtitles") or info.get("automatic_captions") or {}
    for lang in ["en", "en-US"]:
        tracks = requested.get(lang) or []
        if tracks:
            text = tracks[0].get("data") or ""
            if text:
                return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip(), "yt-dlp captions", warnings

    fallback = info.get("description") or info.get("title") or ""
    warnings.append("No public captions were available; metadata text was used as transcript fallback.")
    return fallback, "metadata fallback", warnings


async def extract(url: str, video_id: VideoId) -> dict[str, Any]:
    source_platform = platform(url)
    options = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "en-US"],
    }
    try:
        info = await asyncio.to_thread(lambda: yt_dlp.YoutubeDL(options).extract_info(url, download=False))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not extract public video data: {exc}") from exc

    transcript, transcript_source, warnings = await transcript_for(url, info, source_platform)
    likes = info.get("like_count")
    comments = info.get("comment_count")
    views = info.get("view_count")
    upload_date = info.get("upload_date")
    if isinstance(upload_date, str) and len(upload_date) == 8:
        upload_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"

    return {
        "videoId": video_id,
        "url": url,
        "platform": source_platform,
        "title": info.get("title") or f"{source_platform} video",
        "creator": info.get("uploader") or info.get("channel") or "Unknown creator",
        "followerCount": info.get("channel_follower_count"),
        "views": views,
        "likes": likes,
        "comments": comments,
        "hashtags": list(dict.fromkeys([*(info.get("tags") or []), *hashtags(info.get("description"), info.get("title"))]))[:20],
        "uploadDate": upload_date,
        "durationSeconds": info.get("duration"),
        "thumbnailUrl": info.get("thumbnail"),
        "transcript": transcript,
        "transcriptSource": transcript_source,
        "engagementRate": engagement(likes, comments, views),
        "extractionWarnings": warnings,
    }


def embeddings() -> Embeddings:
    if os.getenv("OPENAI_API_KEY"):
        return OpenAIEmbeddings(model="text-embedding-3-small")
    return LocalHashEmbeddings()


async def build_store(videos: list[dict[str, Any]]) -> tuple[Chroma, list[Document]]:
    splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=140)
    documents: list[Document] = []
    for video in videos:
        text = "\n".join(
            [
                f"Video {video['videoId']}: {video['title']}",
                f"Creator: {video['creator']}",
                f"Engagement rate: {video['engagementRate']}%",
                video["transcript"],
            ]
        )
        chunks = splitter.split_text(text)
        for index, chunk in enumerate(chunks, 1):
            documents.append(
                Document(
                    page_content=chunk,
                    metadata={
                        "video_id": video["videoId"],
                        "chunk_id": f"{video['videoId']}-{index}",
                        "chunk_index": index,
                        "citation": f"Video {video['videoId']}, chunk {index}",
                        "source": video["url"],
                        "title": video["title"],
                    },
                )
            )

    collection_name = f"creator_video_{uuid.uuid4().hex}"
    store = Chroma.from_documents(
        documents,
        embeddings(),
        collection_name=collection_name,
        persist_directory=os.getenv("CHROMA_PERSIST_DIR", "./.chroma"),
    )
    return store, documents


@app.post("/api/analyze")
async def analyze(request: AnalyzeRequest) -> dict[str, Any]:
    videos = await asyncio.gather(extract(str(request.youtubeUrl), "A"), extract(str(request.instagramUrl), "B"))
    store, documents = await build_store(list(videos))
    session_id = str(uuid.uuid4())
    sessions[session_id] = Session(videos=list(videos), vector_store=store, documents=documents)
    return {
        "sessionId": session_id,
        "videos": videos,
        "chunkCount": len(documents),
        "vectorProvider": "ChromaDB persistent local vector DB",
        "llmProvider": "OpenAI GPT-4o-mini" if os.getenv("OPENAI_API_KEY") else "Local extractive fallback",
    }


def fallback_answer(session: Session, message: str, docs: list[Document]) -> str:
    a, b = session.videos
    source_lines = "\n".join(
        f"- [{doc.metadata['citation']}] {' '.join(doc.page_content.split()[:42])}" for doc in docs[:4]
    )
    return (
        f"Video A engagement rate: {a['engagementRate']}%. Video B engagement rate: {b['engagementRate']}%.\n\n"
        f"Video B creator: {b['creator']}; follower count: {b['followerCount'] or 'unavailable'}.\n\n"
        "For Video B, improve the first line, clarify the payoff sooner, and mirror the strongest topic language from the chunks retrieved from Video A.\n\n"
        f"Sources:\n{source_lines}"
    )


async def stream_answer(session: Session, message: str):
    docs = session.vector_store.similarity_search(message, k=6)
    if not os.getenv("OPENAI_API_KEY"):
        answer = fallback_answer(session, message, docs)
        session.memory.extend([{"role": "user", "content": message}, {"role": "assistant", "content": answer}])
        for part in re.findall(r".{1,80}(?:\s|$)", answer, flags=re.S):
            yield part
            await asyncio.sleep(0.02)
        return

    metrics = "\n".join(
        f"Video {video['videoId']}: creator={video['creator']}; views={video['views']}; likes={video['likes']}; comments={video['comments']}; engagement={video['engagementRate']}%; followers={video['followerCount']}"
        for video in session.videos
    )
    context = "\n\n".join(f"[{doc.metadata['citation']}] {doc.page_content}" for doc in docs)
    memory = "\n".join(f"{item['role']}: {item['content']}" for item in session.memory[-8:])
    model = ChatOpenAI(model="gpt-4o-mini", temperature=0.2, streaming=True)
    prompt = (
        "You are a senior creator analytics engineer. Use only the provided metrics and transcript chunks. "
        "Cite every claim with [Video A, chunk N] or [Video B, chunk N]. Be concise and actionable.\n\n"
        f"Metrics:\n{metrics}\n\nMemory:\n{memory or 'None'}\n\nRetrieved chunks:\n{context}\n\nQuestion: {message}"
    )
    full = ""
    async for chunk in model.astream(prompt):
        text = chunk.content if isinstance(chunk.content, str) else ""
        full += text
        yield text
    session.memory.extend([{"role": "user", "content": message}, {"role": "assistant", "content": full}])


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    session = sessions.get(request.sessionId)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found. Analyze videos first.")
    return StreamingResponse(stream_answer(session, request.message), media_type="text/plain")
