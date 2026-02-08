import { NextRequest, NextResponse } from "next/server";
import { getDiff } from "@/lib/bv-client";

const SAFE_REF_PATTERN = /^[a-zA-Z0-9~^._\-/]+$/;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get("since") || "HEAD~5";

  if (!SAFE_REF_PATTERN.test(since)) {
    return NextResponse.json(
      { error: "Invalid git ref format" },
      { status: 400 },
    );
  }

  try {
    const data = await getDiff(since);
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[API /api/diff]", message);
    if (message.includes("BEADS_PROJECT_PATH")) {
      return NextResponse.json(
        { error: "BEADS_PROJECT_PATH not configured", detail: message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Failed to fetch diff", detail: message },
      { status: 500 },
    );
  }
}
