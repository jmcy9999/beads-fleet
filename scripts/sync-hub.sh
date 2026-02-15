#!/usr/bin/env bash
# =============================================================================
# sync-hub.sh -- Synchronize the projects_master hub with all configured repos
# =============================================================================
#
# Auto-discovers repos from ~/.beads-web.json, imports their issues into the
# hub (with rename-on-import), labels each with project:<name>, and keeps
# the hub's config.yaml in sync.
#
# Safe to run repeatedly -- bd import is idempotent (title-matched), and
# label insertion uses INSERT OR IGNORE.
# =============================================================================

set -euo pipefail

BEADS_WEB_CONFIG="$HOME/.beads-web.json"
HUB_PATH="$HOME/dev/projects_master"
HUB_DB="$HUB_PATH/.beads/beads.db"
HUB_CONFIG="$HUB_PATH/.beads/config.yaml"

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if [ ! -f "$HUB_DB" ]; then
  echo "Error: Hub database not found at $HUB_DB"
  exit 1
fi

if ! command -v bd &>/dev/null; then
  echo "Error: 'bd' command not found in PATH"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "Error: 'python3' not found in PATH"
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "Error: 'sqlite3' not found in PATH"
  exit 1
fi

# ---------------------------------------------------------------------------
# Auto-discover repos from ~/.beads-web.json
# ---------------------------------------------------------------------------
# Finds all repos that:
#   1. Are listed in ~/.beads-web.json
#   2. Are NOT the hub itself (projects_master)
#   3. Have a .beads/beads.db (i.e. beads is initialized)
REPO_PATHS=()
REPO_NAMES=()

if [ -f "$BEADS_WEB_CONFIG" ]; then
  while IFS='|' read -r name path; do
    # Skip the hub itself
    if [ "$path" = "$HUB_PATH" ]; then
      continue
    fi
    # Only include repos with beads initialized
    if [ -f "$path/.beads/beads.db" ]; then
      REPO_PATHS+=("$path")
      REPO_NAMES+=("$name")
    fi
  done < <(python3 -c "
import json, sys
with open('$BEADS_WEB_CONFIG') as f:
    cfg = json.load(f)
for r in cfg.get('repos', []):
    print(f\"{r['name']}|{r['path']}\")
")
fi

if [ ${#REPO_PATHS[@]} -eq 0 ]; then
  echo "No repos with beads found in $BEADS_WEB_CONFIG"
  exit 0
fi

# ---------------------------------------------------------------------------
# Update hub config.yaml with any newly discovered repos
# ---------------------------------------------------------------------------
{
  echo "repos:"
  echo "  additional:"
  for repo_path in "${REPO_PATHS[@]}"; do
    echo "    - $repo_path"
  done
} > "$HUB_CONFIG"

echo "=== Hub Sync: $(date '+%Y-%m-%d %H:%M:%S') ==="
echo "Hub: $HUB_PATH"
echo "Repos: ${#REPO_PATHS[@]} configured"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Flush each repo's DB to JSONL, then import into hub
# ---------------------------------------------------------------------------
for repo_path in "${REPO_PATHS[@]}"; do
  project_name="$(basename "$repo_path")"

  echo "--- Syncing $project_name ---"

  # 1a. Flush the repo's DB to JSONL
  if [ -f "$repo_path/.beads/beads.db" ]; then
    echo "  Flushing $project_name JSONL..."
    (cd "$repo_path" && bd sync --flush-only --quiet 2>/dev/null) || {
      echo "  Warning: bd sync --flush-only failed for $project_name (continuing)"
    }
  fi

  # 1b. Find the best JSONL source. bd sync may write to a worktree rather
  #     than the main .beads/issues.jsonl. Prefer whichever has more content.
  main_jsonl="$repo_path/.beads/issues.jsonl"
  worktree_jsonl="$repo_path/.git/beads-worktrees/beads-sync/.beads/issues.jsonl"
  jsonl_path=""

  main_count=0
  worktree_count=0
  [ -f "$main_jsonl" ] && main_count=$(wc -l < "$main_jsonl" | tr -d ' ')
  [ -f "$worktree_jsonl" ] && worktree_count=$(wc -l < "$worktree_jsonl" | tr -d ' ')

  if [ "$worktree_count" -gt 0 ] && [ "$worktree_count" -ge "$main_count" ]; then
    jsonl_path="$worktree_jsonl"
    echo "  Using worktree JSONL ($worktree_count lines)"
  elif [ "$main_count" -gt 0 ]; then
    jsonl_path="$main_jsonl"
    echo "  Using main JSONL ($main_count lines)"
  fi

  # 1c. Import the repo's JSONL into the hub
  if [ -z "$jsonl_path" ]; then
    echo "  No JSONL found for $project_name -- skipping"
    echo ""
    continue
  fi

  # Count issues before import
  count_before=$(sqlite3 "$HUB_DB" 'SELECT COUNT(*) FROM issues WHERE status <> "tombstone";')

  echo "  Importing into hub (rename-on-import)..."
  (cd "$HUB_PATH" && bd import -i "$jsonl_path" --rename-on-import --skip-existing --quiet 2>/dev/null) || {
    echo "  Warning: bd import failed for $project_name (continuing)"
    echo ""
    continue
  }

  count_after=$(sqlite3 "$HUB_DB" 'SELECT COUNT(*) FROM issues WHERE status <> "tombstone";')
  new_count=$((count_after - count_before))

  echo "  Imported: $new_count new issues"
  echo ""
done

# ---------------------------------------------------------------------------
# Step 2: Update existing hub issues with current status from source repos
# ---------------------------------------------------------------------------
echo "--- Updating existing issues ---"

# The import step uses --skip-existing, so status/priority/closed_at changes
# in source repos never propagate to the hub. This step fixes that by
# matching hub issues to source issues by title and updating key fields.
python3 - "$HUB_DB" "${REPO_PATHS[@]}" <<'UPDATE_SCRIPT'
import json
import sqlite3
import sys
import os

hub_db = sys.argv[1]
repo_paths = sys.argv[2:]

# Resolve the best JSONL path (worktree preferred over main)
def resolve_jsonl(repo_path):
    main = os.path.join(repo_path, ".beads", "issues.jsonl")
    worktree = os.path.join(repo_path, ".git", "beads-worktrees", "beads-sync", ".beads", "issues.jsonl")
    main_lines = 0
    worktree_lines = 0
    if os.path.isfile(main):
        with open(main) as f:
            main_lines = sum(1 for line in f if line.strip())
    if os.path.isfile(worktree):
        with open(worktree) as f:
            worktree_lines = sum(1 for line in f if line.strip())
    if worktree_lines > 0 and worktree_lines >= main_lines:
        return worktree
    if main_lines > 0:
        return main
    return None

# Build a map: title -> latest issue data from each repo's JSONL
title_to_source = {}
for repo_path in repo_paths:
    jsonl_path = resolve_jsonl(repo_path)
    if jsonl_path is None:
        continue
    with open(jsonl_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                issue = json.loads(line)
                title = issue.get("title", "")
                if title:
                    title_to_source[title] = issue
            except json.JSONDecodeError:
                continue

conn = sqlite3.connect(hub_db)
cur = conn.cursor()

# Get all hub issues (excluding tombstones)
cur.execute("""
    SELECT id, title, status, priority, closed_at, close_reason, updated_at
    FROM issues
    WHERE status <> 'tombstone'
""")
hub_issues = cur.fetchall()

updated_count = 0
for hub_id, title, hub_status, hub_priority, hub_closed_at, hub_close_reason, hub_updated_at in hub_issues:
    source = title_to_source.get(title)
    if source is None:
        continue

    src_status = source.get("status", hub_status)
    src_priority = source.get("priority", hub_priority)
    src_closed_at = source.get("closed_at") or None
    src_close_reason = source.get("close_reason") or None
    src_updated_at = source.get("updated_at") or hub_updated_at

    # Check if anything changed
    if (src_status == hub_status
        and src_priority == hub_priority
        and src_closed_at == hub_closed_at
        and src_close_reason == hub_close_reason):
        continue

    cur.execute("""
        UPDATE issues
        SET status = ?, priority = ?, closed_at = ?, close_reason = ?, updated_at = ?
        WHERE id = ?
    """, (src_status, src_priority, src_closed_at, src_close_reason, src_updated_at, hub_id))
    updated_count += 1

conn.commit()
conn.close()

if updated_count == 0:
    print("  All hub issues already up to date")
else:
    print(f"  Updated {updated_count} issue(s) with current status from source repos")
UPDATE_SCRIPT

echo ""

# ---------------------------------------------------------------------------
# Step 3: Label unlabelled issues by matching titles to source JSONLs
# ---------------------------------------------------------------------------
echo "--- Labelling issues ---"

# Use python3 for the title-matching and label-insertion logic.
# This is cleaner than trying to do JSON parsing in bash.
python3 - "$HUB_DB" "${REPO_PATHS[@]}" <<'PYTHON_SCRIPT'
import json
import sqlite3
import sys
import os

hub_db = sys.argv[1]
repo_paths = sys.argv[2:]

# Resolve the best JSONL path (worktree preferred over main)
def resolve_jsonl(repo_path):
    main = os.path.join(repo_path, ".beads", "issues.jsonl")
    worktree = os.path.join(repo_path, ".git", "beads-worktrees", "beads-sync", ".beads", "issues.jsonl")
    main_lines = 0
    worktree_lines = 0
    if os.path.isfile(main):
        with open(main) as f:
            main_lines = sum(1 for line in f if line.strip())
    if os.path.isfile(worktree):
        with open(worktree) as f:
            worktree_lines = sum(1 for line in f if line.strip())
    if worktree_lines > 0 and worktree_lines >= main_lines:
        return worktree
    if main_lines > 0:
        return main
    return None

# Build a map: title -> project_name from each repo's JSONL
title_to_project = {}
for repo_path in repo_paths:
    project_name = os.path.basename(repo_path)
    jsonl_path = resolve_jsonl(repo_path)
    if jsonl_path is None:
        continue
    with open(jsonl_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                issue = json.loads(line)
                title = issue.get("title", "")
                if title:
                    # First repo to claim a title wins (shouldn't conflict
                    # since repos have distinct issues)
                    if title not in title_to_project:
                        title_to_project[title] = project_name
            except json.JSONDecodeError:
                continue

conn = sqlite3.connect(hub_db)
cur = conn.cursor()

# Find all hub issues that lack a project:* label
cur.execute("""
    SELECT i.id, i.title
    FROM issues i
    WHERE i.status <> 'tombstone'
      AND NOT EXISTS (
          SELECT 1 FROM labels l
          WHERE l.issue_id = i.id
            AND l.label LIKE 'project:%'
      )
""")
unlabelled = cur.fetchall()

labelled_count = {}  # project_name -> count

for issue_id, title in unlabelled:
    project_name = title_to_project.get(title)
    if project_name is None:
        # Issue was created directly in the hub -- label as projects_master
        project_name = "projects_master"

    label = f"project:{project_name}"
    cur.execute(
        "INSERT OR IGNORE INTO labels (issue_id, label) VALUES (?, ?)",
        (issue_id, label),
    )
    if cur.rowcount > 0:
        labelled_count[project_name] = labelled_count.get(project_name, 0) + 1

conn.commit()
conn.close()

# Report
total_labelled = sum(labelled_count.values())
if total_labelled == 0:
    print("  No new labels needed -- all issues already labelled")
else:
    for project, count in sorted(labelled_count.items()):
        print(f"  Labelled {count} issue(s) as project:{project}")
    print(f"  Total: {total_labelled} new label(s) applied")
PYTHON_SCRIPT

echo ""
echo "=== Sync complete ==="
