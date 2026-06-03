import { NextRequest } from "next/server";

import { answerQuestion } from "../../../lib/rag";
import { getSession } from "../../../lib/sessionStore";

export async function POST(request: NextRequest) {
  let body: { sessionId?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  try {
    if (!body.sessionId || !body.message) {
      return new Response("sessionId and message are required", { status: 400 });
    }

    const session = getSession(body.sessionId);
    if (!session) {
      return new Response("Session not found. Analyze videos first.", { status: 404 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of answerQuestion(session, body.message)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Chat failed", { status: 500 });
  }
}