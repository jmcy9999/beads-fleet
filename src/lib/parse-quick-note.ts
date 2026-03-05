// =============================================================================
// Quick Note Parser
// =============================================================================
//
// Parses shorthand like "fix the login bug -p 0 -t bug" into structured
// bd create arguments. Supports:
//   -p <0-4|P0-P4|critical|high|medium|low|minimal>
//   -t <bug|feature|task|epic|chore>
//   --parent <id>
//   Everything else becomes the title.
// =============================================================================

export interface ParsedNote {
  title: string;
  priority?: number;
  type?: string;
  parent?: string;
}

const PRIORITY_MAP: Record<string, number> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
  p0: 0, p1: 1, p2: 2, p3: 3, p4: 4,
  critical: 0, high: 1, medium: 2, low: 3, minimal: 4,
};

const VALID_TYPES = new Set(["bug", "feature", "task", "epic", "chore"]);

export function parseQuickNote(raw: string): ParsedNote {
  const tokens = raw.trim().split(/\s+/);
  const titleParts: string[] = [];
  let priority: number | undefined;
  let type: string | undefined;
  let parent: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if ((tok === "-p" || tok === "--priority") && i + 1 < tokens.length) {
      const val = tokens[++i].toLowerCase();
      if (val in PRIORITY_MAP) {
        priority = PRIORITY_MAP[val];
      } else {
        titleParts.push(tok, val);
      }
    } else if ((tok === "-t" || tok === "--type") && i + 1 < tokens.length) {
      const val = tokens[++i].toLowerCase();
      if (VALID_TYPES.has(val)) {
        type = val;
      } else {
        titleParts.push(tok, val);
      }
    } else if (tok === "--parent" && i + 1 < tokens.length) {
      parent = tokens[++i];
    } else {
      titleParts.push(tok);
    }
  }

  return {
    title: titleParts.join(" "),
    ...(priority !== undefined && { priority }),
    ...(type && { type }),
    ...(parent && { parent }),
  };
}
