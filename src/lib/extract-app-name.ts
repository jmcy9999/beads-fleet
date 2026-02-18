/**
 * Extract a PascalCase app name from an epic title.
 *
 * Supports multiple naming conventions:
 * - "LensCycle: Contact lens reminder app" -> "LensCycle"
 * - "LensCycle Pipeline v2 Rebuild" -> "LensCycle"
 * - "LensCycle" -> "LensCycle"
 *
 * Returns null if no app name can be extracted.
 */
export function extractAppName(epicTitle: string | undefined): string | null {
  if (!epicTitle) return null;
  // "LensCycle: Contact lens reminder app" -> "LensCycle"
  const colonIdx = epicTitle.indexOf(":");
  if (colonIdx > 0) {
    const name = epicTitle.slice(0, colonIdx).trim();
    if (/^[a-zA-Z0-9_-]+$/.test(name)) return name;
  }
  // If the whole title is a single identifier, use it
  if (/^[a-zA-Z0-9_-]+$/.test(epicTitle.trim())) return epicTitle.trim();
  // "LensCycle Pipeline v2 Rebuild" -> "LensCycle" (first PascalCase word)
  const pascalMatch = epicTitle.match(/^([A-Z][a-zA-Z0-9]+)/);
  if (pascalMatch) return pascalMatch[1];
  return null;
}
