# TASK: Fleet Board Help Sidebar (cycle-apps-factory-5dr)

## What to build
Add a help panel to the beads-fleet dashboard sidebar that explains how the fleet board works.

### Requirements
1. **Flow diagram** — visual pipeline: Candidates → Research → Plan → Build → Review → UI Polish → QA → Prepare for Launch → Launched → Refit. Show that stages can be skipped.
2. **Stage descriptions** — 1-2 lines each explaining what happens at each stage
3. **Actions per stage** — what the user can do (promote, skip, assign agent, etc.)
4. **Toggle** — help sidebar should be collapsible, not always visible
5. **Styling** — match existing fleet board dark theme

### Tech context
- This is a Next.js app (beads_web)
- Fleet board lives in the fleet/ route
- Check existing code structure before building

## When Done
Close the bead: `cd ~/dev/claude_projects/cycle-apps-factory && bd close cycle-apps-factory-5dr`
Run: `openclaw system event --text "Done: Fleet board help sidebar built" --mode now`
