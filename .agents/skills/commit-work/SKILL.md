---
name: "commit-work"
description: "When explicitly requested, review and stage intended changes, split logical commits, or write commit messages and create commits."
---

# Commit work

Inspect git status, unstaged changes, and the index before staging. Establish the intended scope from the request; preserve unrelated tracked, untracked, and already-staged work.

Group changes by coherent behavior. Stage exact paths or use patch staging for mixed files; never stage everything merely to clean the tree. Verify the actual staged diff and run relevant checks before committing.

Follow the repository's existing commit convention or the user's preference. Do not mandate Conventional Commits without a project convention. Write a concise subject explaining the change and a body only when useful; preserve multiline messages with a file.

A staging or message request authorizes that action only. Create commits when requested; push separately only when included in the request. Complete with the requested artifact or commit IDs and actual validation. A dirty tree containing unrelated work is a valid outcome.
