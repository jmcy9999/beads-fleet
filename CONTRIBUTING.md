# Contributing to Beads Web

Welcome! Beads Web is a Next.js 14 TypeScript dashboard for the [Beads](https://github.com/jmcy9999/beads) issue tracker. Whether you are fixing a typo, reporting a bug, or building a new feature, your contributions are appreciated.

## Code of Conduct

This project follows the guidelines in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). By participating you agree to uphold a respectful and inclusive environment for everyone.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/jmcy9999/beads-web/issues) and include:

1. Steps to reproduce the problem
2. Expected behaviour
3. Actual behaviour
4. Environment details (OS, Node.js version, browser)
5. Relevant console output or screenshots

The more detail you provide, the faster we can diagnose and fix the issue.

## Suggesting Features

Open a [GitHub Issue](https://github.com/jmcy9999/beads-web/issues) with the **enhancement** label. Describe the use case, the proposed behaviour, and any alternatives you considered.

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- At least one Beads-initialized repository (run `bd init` inside a repo)

### Steps

1. **Fork and clone** the repository:
   ```bash
   git clone https://github.com/<your-username>/beads-web.git
   cd beads-web
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Configure the environment** -- create a `.env.local` file in the project root:
   ```
   BEADS_PROJECT_PATH=/path/to/your/beads-project
   ```
   This should point to a directory containing one or more repos that have been initialized with `bd init`.
4. **Start the dev server**:
   ```bash
   npm run dev
   ```
5. Open [http://localhost:3000](http://localhost:3000) and verify the dashboard loads.

## Project Structure

```
src/
  app/                  Next.js App Router pages (board, diff, insights, issue, settings)
    api/                API route handlers (diff, health, insights, issues, priority, repos)
  components/           React components
    board/              Kanban board views
    dashboard/          Main dashboard views
    filters/            Filter controls
    insights/           Analytics and graph views
    layout/             Shell and navigation
    providers/          Context and query providers
    ui/                 Shared UI primitives
  hooks/                Custom React hooks
    useHealth.ts        Backend health check
    useIssues.ts        Issue fetching and filtering
    useRepos.ts         Repository listing
    useInsights.ts      Analytics data
    useDiff.ts          Diff viewing
    usePriority.ts      Priority management
    useKeyboardShortcuts.ts
  lib/                  Core logic
    bv-client.ts        Beads CLI client interface
    sqlite-reader.ts    SQLite database reader
    jsonl-fallback.ts   JSONL fallback when SQLite is unavailable
    types.ts            Shared TypeScript types
    cache.ts            Server-side caching
    repo-config.ts      Repository configuration
    recipes.ts          Predefined query recipes
docs/                   Design documents
```

## Code Style

- **TypeScript strict mode** -- avoid `any` types wherever possible.
- **ESLint** with `next/core-web-vitals` -- run `npm run lint` before committing.
- **Tailwind CSS** for all styling -- avoid custom CSS files.
- **Server-side data fetching** via API routes in `src/app/api/`.
- **React Query** (`@tanstack/react-query`) for client-side data management through the hooks in `src/hooks/`.
- **Functional components** and hooks only -- no class components.
- **Named exports** preferred, except where Next.js conventions require default exports.

## Pull Request Process

1. Create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature main
   ```
2. Make your changes.
3. Ensure checks pass:
   ```bash
   npm run lint
   npm run build
   ```
4. Commit using [Conventional Commits](#commit-message-convention) (see below).
5. Push and open a pull request against `main`.
6. Write a clear PR title and description explaining what changed and why.
7. All CI checks must pass before the PR can be merged.

## Commit Message Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add issue search to dashboard
fix: correct priority sorting in kanban board
docs: update deployment instructions
refactor: extract filter logic into shared hook
test: add unit tests for sqlite-reader
ci: add build caching to GitHub Actions
```

| Prefix      | When to use                                          |
|-------------|------------------------------------------------------|
| `feat:`     | A new feature                                        |
| `fix:`      | A bug fix                                            |
| `docs:`     | Documentation only                                   |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:`     | Adding or updating tests                             |
| `ci:`       | CI/CD configuration changes                          |
| `chore:`    | Maintenance tasks (dependency updates, tooling, etc.)|

## First-Time Contributors

New here? Look for issues labelled **good first issue** in the [issue tracker](https://github.com/jmcy9999/beads-web/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). These are scoped to be approachable without deep knowledge of the codebase.

If you have questions at any point, feel free to open a [discussion](https://github.com/jmcy9999/beads-web/discussions) or comment on the relevant issue. We are happy to help.
