---
name: clean-commits
description: Lands work as a sequence of clean Conventional Commits, one coherent unit of work per commit, with strict rules for commit titles, staging, and commit messages. The rules every dacapo worker follows in its branch and every dacapo squash commit follows on dev. Invoked by the user via /clean-commits.
---

## Commit title rules

- Every commit title follows Conventional Commits format: `type: description` (e.g. `feat: add login endpoint`)
- **Allowed types only** — use exclusively: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `revert`. Any other type (e.g. `copy`, `update`, `change`) is forbidden.
- **No parenthetical scope** — never write `feat(auth): ...`, instead write `feat: add auth login endpoint`
- Breaking changes use `!` before the colon: `feat!: drop Node 14 support`
- Each commit is one coherent, independently committable unit of work
- Commits are ordered so each builds on the previous

## Committing

Work through units **one at a time**:

1. Implement the unit fully
2. Stage the changes:
   - If new/untracked files were added: stage them explicitly by name, then `git add -u` for modified tracked files
   - If no new files were added: use `git add -u`
3. Commit: `git commit -m "<title>"`
   - The commit message contains **only** the title — no body, no additional lines. A `Co-Authored-By` trailer added by the tooling is fine.
   - **Forbidden git commands**: never use `git rm`, `git reset`, `git rebase`, `git push --force`, or any command that rewrites history or removes tracked files
4. Move to the next unit

## In a dacapo run

dacapo hands these rules to every worker in its brief, so a worker's branch is a sequence of clean commits. When dacapo squash-merges a branch into `dev`, the squash commit's title is the one the orchestrator planned for that task, written to these same rules, and `dev` is only ever fast-forwarded onto `main`. The mod itself never rebases or rewrites history; a conflicting branch is reported, not resolved.
