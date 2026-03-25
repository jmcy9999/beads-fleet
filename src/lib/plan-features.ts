/**
 * Extract features from a markdown plan document.
 *
 * Plans vary in format, so we try multiple heuristics:
 * 1. H2/H3 sections that look like feature headings
 * 2. Numbered or bullet lists under "Features", "Scope", "Tasks" sections
 * 3. Table rows with feature names
 */

export interface PlanFeature {
  /** Stable ID derived from position */
  id: string;
  /** Feature name/title */
  name: string;
  /** Optional description extracted after the heading or from the list item */
  description?: string;
}

/**
 * Parse a markdown plan and extract a list of features.
 * Returns an empty array if no features can be identified.
 */
export function extractFeaturesFromPlan(markdown: string): PlanFeature[] {
  const features: PlanFeature[] = [];
  const lines = markdown.split("\n");

  // Strategy 1: Look for a "Features" / "Scope" / "Build Scope" section
  // and extract bullet/numbered items from it
  const sectionPattern = /^##\s+.*(?:features|scope|deliverables|requirements|tasks|build\s+plan)/i;
  let inFeatureSection = false;
  let sectionDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for section headings
    const headingMatch = line.match(/^(#{2,3})\s+(.+)/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const title = headingMatch[2].trim();

      if (sectionPattern.test(line)) {
        inFeatureSection = true;
        sectionDepth = depth;
        continue;
      }

      // End feature section if we hit a same-or-higher-level heading
      if (inFeatureSection && depth <= sectionDepth) {
        inFeatureSection = false;
      }
    }

    // Extract items from feature section
    if (inFeatureSection) {
      const listMatch = line.match(/^\s*[-*]\s+\*?\*?(.+?)\*?\*?\s*$/);
      const numberedMatch = line.match(/^\s*\d+[.)]\s+\*?\*?(.+?)\*?\*?\s*$/);
      const item = listMatch?.[1] ?? numberedMatch?.[1];
      if (item) {
        const clean = item.replace(/\*\*/g, "").trim();
        // Skip items that look like metadata (dates, statuses, IDs)
        if (clean.length > 3 && !/^(status|date|id|note|see )/i.test(clean)) {
          features.push({
            id: `feat-${features.length + 1}`,
            name: clean,
          });
        }
      }
    }
  }

  // Strategy 2: If no features found from sections, try extracting H3 headings
  // that look like feature names (not metadata headings)
  if (features.length === 0) {
    const skipHeadings = /^(progress|summary|reference|notes|status|overview|context|background|phase\s+\d)/i;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^###\s+(.+)/);
      if (match) {
        const title = match[1].replace(/\*\*/g, "").trim();
        if (!skipHeadings.test(title) && title.length > 3 && title.length < 120) {
          // Grab next non-empty line as description if it's not a heading
          let desc: string | undefined;
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const next = lines[j].trim();
            if (next && !next.startsWith("#")) {
              desc = next.replace(/^[-*]\s+/, "").slice(0, 200);
              break;
            }
          }
          features.push({
            id: `feat-${features.length + 1}`,
            name: title,
            description: desc,
          });
        }
      }
    }
  }

  // Strategy 3: If still nothing, try top-level bullet items from the whole doc
  if (features.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^[-*]\s+\*?\*?(.+?)\*?\*?\s*$/);
      if (match) {
        const item = match[1].replace(/\*\*/g, "").trim();
        // Only take substantial items that look like features
        if (item.length > 10 && item.length < 150 && !/^(see |note:|status:|http)/i.test(item)) {
          features.push({
            id: `feat-${features.length + 1}`,
            name: item,
          });
        }
      }
    }
    // Cap at 20 items max from this fallback
    features.splice(20);
  }

  return features;
}
