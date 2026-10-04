# Issue tracker: GitHub

Issues and published specifications live in GitHub Issues. Use `gh`; infer the repository from the Git remote and pass `--repo owner/name` when needed. Read/list operations can support exploration. Create, edit, comment, close, or publish only when the requested workflow includes that action.

- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels` with relevant filters.
- Publish: `gh issue create --title "..." --body-file <file>`.
- Update: `gh issue edit <number> --body-file <file>`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Labels: `gh issue edit <number> --add-label "..." --remove-label "..."` using existing canonical labels.

Preserve multiline bodies through a UTF-8 file. PowerShell example:

```powershell
$issueBodyPath = Join-Path $env:TEMP 'feather-lite-issue-body.md'
@'
Concrete problem and intended behavior.

Acceptance criteria and validation.
'@ | Set-Content -LiteralPath $issueBodyPath -Encoding utf8
gh issue create --title "Concrete change" --body-file $issueBodyPath
```

PRs are not an incoming feature-request triage surface here. For ordinary PR work use `gh pr view`, `gh pr diff`, and the equivalent `--body-file` publication commands. GitHub shares issue/PR numbers; resolve the artifact type before editing it. Attach created PRs to the Codex chat using the available attachment tool.

Ticket dependencies use native GitHub issue dependencies when available; otherwise link a `Blocked by: #<number>` line. Do not create a separate wayfinding map or new labels unless the task needs that workflow.
