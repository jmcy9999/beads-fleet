import { NextResponse } from "next/server";
import { promises as fs } from "fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEALTH_FILE = "/tmp/fleet-watchdog-health.json";

/**
 * GET /api/fleet/health — Returns watchdog health status.
 *
 * The fleet-watchdog.sh script writes health status to a JSON file every
 * 5 minutes. This endpoint reads and returns that file.
 */
export async function GET() {
  try {
    const data = await fs.readFile(HEALTH_FILE, "utf-8");
    const health = JSON.parse(data);
    return NextResponse.json(health);
  } catch {
    // Watchdog not running or no health file yet
    return NextResponse.json({
      status: "unknown",
      message: "Watchdog not running or no health data available",
      agentCount: 0,
      lastCheck: null,
      stallThresholdMinutes: 20,
    });
  }
}
