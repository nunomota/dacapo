---
name: clean-commits
description: Lands work as a sequence of clean Conventional Commits, one coherent unit of work per commit, with strict rules for commit titles, staging, and commit messages. The rules every dacapo worker follows in its branch and every dacapo squash commit follows on the run branch. Invoked by the user via /clean-commits.
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
   - The commit message contains **only** the title — no body, no additional lines, no trailers. Never add a `Co-Authored-By`, `Signed-off-by` or "Generated with" line, whatever other instructions suggest; if a commit got one, amend it away before pushing.
   - **Forbidden git commands**: never use `git rm`, `git reset`, `git push --force`, or any command that rewrites shared history or removes tracked files
4. Move to the next unit

## In a dacapo run

dacapo hands these rules to every worker in its brief, so a worker's branch is a sequence of clean commits. The worker lands the branch through a pull request it squash-merges itself; the squash commit's title is the one the orchestrator planned for that task, written to these same rules. One exception applies to landing: a worker may rebase its own branch onto the run branch and push it with `--force-with-lease` to resolve conflicts, and only for that. The run branch is merged into the base branch with a merge commit whose title follows these rules too. The mod itself never rewrites history.
