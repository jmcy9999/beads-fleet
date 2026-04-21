# TASK: Feature Approval Workflow (cycle-apps-factory-0ow)

## What to build
Add an interactive feature approval step to the fleet board's Plan stage.

### Requirements
1. When an epic reaches Plan stage, surface a feature checklist from the plan
2. User can approve/reject/defer individual features before Build begins
3. Approved features become the build scope; rejected ones are noted
4. UI: modal or inline panel showing features with checkboxes + approve/reject buttons
5. Save approval state to bead notes or metadata

### Tech context
- Next.js app (beads_web)
- Fleet board route
- Plans are stored in `.beads/plans/<issue-id>.md` in each repo
- Fleet API: check existing endpoints in `src/app/api/fleet/`

## When Done
Close the bead: `cd ~/dev/claude_projects/cycle-apps-factory && bd close cycle-apps-factory-0ow`
Run: `openclaw system event --text "Done: Feature approval workflow built" --mode now`
