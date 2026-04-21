# Fleet Action Prompts Fix — Architecture Design

**Bead:** beads_web-sz8
**Date:** 2026-04-14

## Summary

Transform ad-hoc prompts in fleet/action/route.ts into agent-aware orchestration. Three changes:

1. **Extract full ship type** (not just venture/non-venture) — line 136-137
2. **Add `--agent` flag support** to agent-launcher.ts — `agentName` param builds `--agent <name>` CLI flag
3. **Fix all 10 action prompts** to reference agent files and pass ship type

## Key Design Decisions

- `--agent <name>` flag auto-loads the agent file as system prompt — prompts just need task context
- Ship type in prompt lets agents load correct platform standards
- Platform-specific QA agents (ios/qa.md, macos/qa.md) selected when available, generic fallback otherwise
- Development actions don't use --agent (workflows.md is instructions, not a frontmatter agent)
- Product repo creation handled by planner agent Step 2, not by route.ts

## Files to Modify

- `src/lib/agent-launcher.ts` — add `agentName` to LaunchOptions, build --agent flag
- `src/app/api/fleet/action/route.ts` — ship type extraction + all 10 action prompts

## Actions and Their Agents

| Action | Agent File | --agent flag |
|--------|-----------|-------------|
| start-research | .claude/agents/research.md | research |
| more-research | .claude/agents/research.md | research |
| generate-plan | .claude/agents/planner.md | planner |
| skip-to-plan | .claude/agents/planner.md | planner |
| revise-plan | .claude/agents/planner.md | planner |
| send-for-development | .claude/agents/workflows.md | (none — instructions only) |
| approve-and-build | .claude/agents/workflows.md | (none) |
| send-back-to-dev | .claude/agents/workflows.md | (none) |
| send-for-qa | .claude/agents/qa.md or platforms/<type>/qa.md | qa or platforms/<type>/qa |
| qa-fix-and-retest | .claude/agents/workflows.md | (none) |
