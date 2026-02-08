import { NextResponse } from "next/server";
import { access, stat } from "fs/promises";
import { join } from "path";
import { checkBvAvailable } from "@/lib/bv-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const bvAvailable = await checkBvAvailable();
  const projectPath = process.env.BEADS_PROJECT_PATH || "";

  let projectValid = false;
  if (projectPath) {
    try {
      await access(projectPath);
      const beadsDir = join(projectPath, ".beads");
      const dirStat = await stat(beadsDir);
      projectValid = dirStat.isDirectory();
    } catch {
      projectValid = false;
    }
  }

  return NextResponse.json({
    bv_available: bvAvailable,
    project_path: projectPath,
    project_valid: projectValid,
  });
}
