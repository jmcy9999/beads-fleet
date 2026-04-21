# TASK: Fleet Board UX Fix (P0 Bug)

Bead: cycle-apps-factory-tst — Fleet board: add jump links and collapsible sections for research/plan

## Problem
On the fleet board issue detail page, research report and build plan sections require scrolling. Hard to find.

## What to Build
1. **Jump links** — Add anchor links/tabs/mini nav at top of issue detail page to jump to Research Report or Build Plan sections
2. **Collapsible sections** — Both Research Report and Build Plan should be collapsible/expandable (collapsed by default, expand on click)

## Where
- This is in the beads_web codebase (Next.js)
- Look at the issue detail/fleet pages

## When Done
Run: `openclaw system event --text "Done: Fleet board jump links and collapsible sections (P0 bug fix)" --mode now`
