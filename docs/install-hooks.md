# Installing Git Hooks

Git hooks live in `scripts/hooks/` (committed, single source of truth). `.git/hooks/` is per-clone and not tracked by git. Install hooks manually after cloning.

## Prerequisites

- **flock** (build serialization): `brew install util-linux && brew link util-linux --force`

## Install post-commit hook

Symlink (preferred — stays in sync with committed source):

```bash
cd /Users/janemckay/dev/claude_projects/beads_web
ln -sf ../../scripts/hooks/post-commit .git/hooks/post-commit
chmod +x scripts/hooks/post-commit
```

Or copy (if symlinks are not supported):

```bash
cp scripts/hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

## Verify

Trigger a no-op commit (e.g., whitespace edit to any file). The hook should:

1. Rebuild the prod bundle (`npm run build`).
2. Check for active agents (`tmux list-sessions | grep shipyard-`).
3. Restart prod if idle, or log a warning if agents are running.

## Disable

Rename or remove the hook:

```bash
mv .git/hooks/post-commit .git/hooks/post-commit.disabled
```

Or remove the symlink:

```bash
rm .git/hooks/post-commit
```
