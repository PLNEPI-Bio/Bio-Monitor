# Agent Teams — Master Reference

Source: https://code.claude.com/docs/en/agent-teams (+ `/docs/en/hooks`, `/docs/en/costs`)
Compiled: 2026-07-22 · Docs describe behavior as of Claude Code v2.1.178+ (version-gated notes marked inline)

> **Purpose of this file:** the single reference Claude should read before proposing, spawning,
> or steering an agent team in this project. It covers what teams are, when they're worth the
> cost, exact config/paths/hooks, and the failure modes to plan around.

---

## 0. TL;DR for this project

| Item | Status here |
| :--- | :--- |
| Feature flag | ✅ Enabled — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in [.claude/settings.local.json](../.claude/settings.local.json) |
| Display mode | **In-process only.** Split panes need tmux or iTerm2; unsupported in VS Code's integrated terminal, Windows Terminal, and Ghostty. This is a Windows + VS Code box → never suggest `--teammate-mode tmux`/`iterm2`. |
| Codebase shape | Bio-Monitor is dominated by a single giant [index.html](../index.html). **Parallel implementation teammates will collide on that file.** Teams here are for *research, review, and investigation* — not concurrent editing. |
| Default team size | 3, occasionally up to 5. Never more without a reason. |
| Teammate model | Sonnet unless the task genuinely needs Opus. |

---

## 1. What an agent team is

Multiple independent Claude Code instances coordinating on one job:

| Component | Role |
| :--- | :--- |
| **Team lead** | The main session. Spawns teammates, creates/assigns tasks, synthesizes results. |
| **Teammates** | Separate full Claude Code sessions, each with its own context window. |
| **Task list** | Shared work items that teammates claim and complete (file-locked against races). |
| **Mailbox** | JSON-file messaging system between agents. |

The lead is fixed for the session's lifetime — leadership can't be transferred, and teammates
cannot spawn their own teammates (no nested teams). One team per session.

---

## 2. Teams vs. subagents — pick correctly

|  | Subagents | Agent teams |
| :--- | :--- | :--- |
| **Context** | Own window; result returns to caller | Own window; fully independent |
| **Communication** | Report back to main agent only | Teammates message **each other** directly |
| **Coordination** | Main agent manages all work | Shared task list, self-claiming |
| **Best for** | Focused tasks where only the result matters | Work requiring discussion & mutual challenge |
| **Token cost** | Lower (summarized back) | Higher (each teammate is a full instance) |
| **User access** | Cannot be addressed directly | Can be messaged/interrupted individually |

**Decision rule:** if the workers would benefit from arguing with each other, use a team.
If you just need N answers collected, use subagents. If the work is sequential, touches the
same files, or has heavy dependencies — use a single session.

### Strong use cases
- **Research and review** — several angles investigated simultaneously, then cross-challenged.
- **New modules/features** — each teammate owns a disjoint set of files.
- **Debugging with competing hypotheses** — parallel theories, adversarial convergence.
- **Cross-layer coordination** — frontend / backend / tests each owned separately.

### Anti-patterns
Sequential work · same-file edits · dependency-heavy chains · routine one-shot tasks.

---

## 3. Enable

```json
// settings.json / .claude/settings.local.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Without the flag: no team is set up at session start, no team directories are written, and
Claude will neither spawn nor propose teammates. Env-var equivalent works too. Changes apply
at startup — restart the session.

---

## 4. Spawning

Teams form when the **first teammate is spawned**; the main session becomes lead. No setup
step, no `TeamCreate`/`TeamDelete` (both removed in v2.1.178). Cleanup is automatic at session
exit. The `team_name` input on the Agent tool is accepted but ignored.

Two paths, both requiring your approval:
1. **You request** teammates explicitly.
2. **Claude proposes** them when it judges the task benefits from parallelism.

```text
I'm designing a CLI tool that helps developers track TODO comments across
their codebase. Spawn three teammates to explore this from different angles:
one on UX, one on technical architecture, one playing devil's advocate.
```

⚠️ Claude sometimes uses **subagents** instead — and subagents appear in the *same* agent
panel, so the panel alone doesn't prove a team formed. If that happens, ask again and say
"agent team" explicitly.

### Naming, count, and model
- The lead names each teammate at spawn. **Tell it what to call them** if you want to
  reference them in later prompts.
- Teammates do **not** inherit the lead's `/model`. Set **Default teammate model** in
  `/config`; pick *Default (leader's model)* to follow the lead.
- Teammates **do** inherit the lead's effort level (split-pane: v2.1.186+).
- Model and fast mode are **fixed at spawn** — `/model` and `/fast` while viewing a teammate
  only change the lead (v2.1.199+ shows a notice saying so). `/effort` *does* apply to the
  viewed teammate's later turns.

```text
Spawn 4 teammates to refactor these modules in parallel. Use Sonnet for each teammate.
```

### Reusing subagent definitions as teammates
Reference any subagent type (project / user / plugin / CLI scope) by name:

```text
Spawn a teammate using the security-reviewer agent type to audit the auth module.
```

- Honors that definition's `tools` allowlist and `model`.
- The definition's body is **appended** to the teammate's system prompt (does not replace it).
- `SendMessage` and task-management tools remain available even under a restrictive `tools` list.
- ⚠️ `skills` and `mcpServers` frontmatter is **not** applied to teammates — they load skills
  and MCP servers from project/user settings like a normal session.

### Plan approval gate
```text
Spawn an architect teammate to refactor the authentication module.
Require plan approval before they make any changes.
```
Teammate works read-only in plan mode → submits plan to lead → lead approves (exits plan mode,
implements) or rejects with feedback (revises, resubmits). **The lead decides autonomously**,
so put your criteria in the prompt: *"only approve plans that include test coverage"*,
*"reject plans that touch the Supabase schema"*.

---

## 5. Driving the team (in-process mode)

Agent panel sits below the prompt input:

| Key | Action |
| :--- | :--- |
| ↑ / ↓ | Select a teammate |
| Enter | Open its transcript; type to message it directly |
| Esc | Interrupt the selected teammate's current turn |
| `x` | Stop the selected teammate |
| Ctrl+T | Toggle the task list |

While viewing a teammate, plain text and skills go to that teammate; **built-in slash commands
still run in the lead's session.**

**Idle-row behavior (v2.1.199+):** an idle teammate's row stays visible while *any* agent is
still working. Once everything is idle, rows hide after 30s and reappear on the teammate's next
turn — the teammate is still running and addressable while hidden. More than three idle at
once collapses into one `N idle agents` row (Enter expands, Esc collapses). Working, failed,
and currently-viewed teammates always keep their own row.
*(v2.1.181–2.1.198: rows hid 30s after their own turn ended. Before 2.1.181: never hidden.)*

### Display modes
- `"in-process"` — **default**, works in any terminal. ← use this here.
- `"auto"` — split panes if already in tmux, or iTerm2 with `it2` CLI; else in-process.
- `"tmux"` — split panes, auto-detecting tmux vs iTerm2.
- `"iterm2"` (v2.1.186+) — iTerm2 native panes; requires the `it2` CLI.

```json
// ~/.claude/settings.json
{ "teammateMode": "auto" }
```
```bash
claude --teammate-mode auto   # experimental, not in --help
```
*(Default was `"auto"` before v2.1.179 — upgraded sessions now stay single-terminal.)*

### Tasks
Three states: **pending → in progress → completed**, plus dependencies. A pending task with
unresolved dependencies can't be claimed; completing a blocker unblocks dependents
automatically. Claiming uses file locking to avoid races.

- **Lead assigns**: tell the lead which task goes to whom.
- **Self-claim**: a finished teammate picks up the next unassigned, unblocked task itself.

### Shutdown
```text
Ask the researcher teammate to shut down
```
The lead sends a shutdown request; the teammate may approve (exits gracefully) or reject with
an explanation. Shared directories are cleaned up automatically at session end.

---

## 6. Permissions model

- Teammates **start with the lead's permission settings**. `--dangerously-skip-permissions` on
  the lead applies to all of them.
- Per-teammate modes **cannot** be set at spawn time; you can change them after spawning.
- Teammate permission prompts surface **in the lead session** — approve them there yourself.
- `SendMessage` traffic is marked as coming from another Claude session, not from you. A
  teammate **cannot** approve a permission prompt on your behalf, and a denied teammate cannot
  relay the action through another teammate to bypass the check. In auto mode, a relayed
  "it was approved" claim is treated as untrusted input.
- **Plan approval is the one designed exception**: the lead grants teammate plan approvals
  without prompting you.
- 💡 Pre-approve common operations in permission settings *before* spawning, or the lead
  drowns in prompts.

---

## 7. Storage & architecture

Team name is session-derived: `session-` + first 8 chars of the session ID.

| Path | Lifetime |
| :--- | :--- |
| `~/.claude/teams/{team-name}/config.json` | **Removed when the session ends** |
| `~/.claude/teams/{team-name}/inboxes/{agent-name}.json` | Per-agent mailbox |
| `~/.claude/tasks/{team-name}/` | **Persists locally**, never uploaded → resumed sessions keep tasks. Retention follows `cleanupPeriodDays`. |

- Both are generated automatically at session startup and updated as teammates join/idle/leave.
- **Never hand-edit or pre-author `config.json`** — it holds runtime state (session IDs, tmux
  pane IDs) and is overwritten on the next state update.
- `config.json` has a `members` array of name + agent ID. The lead's entry always carries agent
  type `team-lead`; a teammate's entry includes an agent type only if spawned from a subagent
  definition. Teammates can read this file to discover each other.
- **There is no project-level team config.** A `.claude/teams/teams.json` in the repo is *not*
  recognized — it's just an ordinary file. Define reusable roles as subagent definitions instead.
- Mailbox entries are validated on read (v2.1.207+): malformed entries are reported and removed,
  valid messages still deliver. Before 2.1.207 one bad entry caused a per-second error loop and
  blocked that mailbox until you deleted the file manually.

### Context & communication
Each teammate loads the same project context as a regular session — **CLAUDE.md, MCP servers,
skills** — plus the lead's spawn prompt. **The lead's conversation history does not carry over.**

- Messages are delivered automatically; the lead never polls.
- Idle notification is automatic. (v2.1.198+: a teammate whose turn ends on an API error tells
  the lead it *failed* and includes the error text, instead of looking like it finished.)
- Messaging is one recipient at a time — to reach everyone, send one message per teammate.

---

## 8. Hooks — quality gates

Three team-specific events, all registered in `.claude/settings.json`.

| Event | Fires | Matcher | Exit 2 effect |
| :--- | :--- | :--- | :--- |
| `TeammateIdle` | Teammate about to go idle | agent type (`general-purpose`, `Explore`, `Plan`, custom names, `^my-plugin:reviewer$`) | Teammate keeps working; stderr shown to Claude |
| `TaskCreated` | Task being created via `TaskCreate` | none — always fires | Rolls back creation; stderr is blocking feedback |
| `TaskCompleted` | Task being marked complete | none — always fires | Prevents completion; stderr is blocking feedback |

All three also accept JSON output: `{"decision": "block", "reason": "..."}` on the two Task
events, and `{"continue": false, "stopReason": "..."}` on any of them — which stops the agent
entirely (on `TeammateIdle` this matches `Stop` behavior and halts the whole team workflow).
Exit 0 / no output = proceed normally.

**Payloads** (plus the common `session_id`, `transcript_path`, `cwd`, `hook_event_name`):

```json
{
  "hook_event_name": "TeammateIdle",
  "agent_id": "teammate-123",
  "agent_type": "Explore"
}
```
```json
{
  "hook_event_name": "TaskCreated",
  "task_id": "task-456",
  "task_input": { "title": "Review code changes", "description": "Check the PR for style issues" }
}
```
`TaskCompleted` carries the same shape as `TaskCreated` (`task_id` + the task's original
`task_input`).

**Registration:**
```json
{
  "hooks": {
    "TeammateIdle": [
      { "matcher": "Explore",
        "hooks": [{ "type": "command", "command": "/path/to/check-explore-status.sh" }] }
    ],
    "TaskCreated": [
      { "hooks": [{ "type": "command", "command": "/path/to/validate-task.sh" }] }
    ],
    "TaskCompleted": [
      { "hooks": [{ "type": "command", "command": "/path/to/log-task-completion.sh" }] }
    ]
  }
}
```

---

## 9. Cost

**Agent teams use roughly 7× the tokens of a standard session when teammates run in plan mode.**
Usage scales with active teammate count × how long each runs.

Cost controls, in order of impact:
1. **Use Sonnet for teammates** — good capability/cost balance for coordination work.
2. **Keep teams small** — cost is ~linear in team size.
3. **Keep spawn prompts focused** — teammates auto-load CLAUDE.md/MCP/skills; everything you
   add to the spawn prompt is context from turn one.
4. **Shut teammates down when done** — an active teammate keeps consuming until it exits or
   the session ends.
5. **Keep tasks small and self-contained** to bound per-teammate context growth.

Worth it for research, review, and new-feature work. Not worth it for routine tasks.

---

## 10. Best practices

**Give teammates enough context.** They get CLAUDE.md/MCP/skills but *not* the lead's history.
Put the specifics in the spawn prompt:
```text
Spawn a security reviewer teammate with the prompt: "Review the authentication module
at src/auth/ for security vulnerabilities. Focus on token handling, session
management, and input validation. The app uses JWT tokens stored in
httpOnly cookies. Report any issues with severity ratings."
```

**Team size: start with 3–5.** No hard limit, but token cost scales linearly, coordination
overhead rises, and returns diminish. *Three focused teammates often outperform five scattered
ones.* Target **5–6 tasks per teammate** — 15 independent tasks ≈ 3 teammates.

**Size tasks right.** Too small → coordination overhead exceeds benefit. Too large → long
stretches without check-in, more wasted effort. Right → a self-contained unit with a clear
deliverable (a function, a test file, a review). If the lead isn't creating enough tasks, tell
it to split the work further; more tasks also let it reassign when someone gets stuck.

**Make the lead wait.** If it starts implementing instead of delegating:
```text
Wait for your teammates to complete their tasks before proceeding
```

**Start with research and review.** PR reviews, library research, bug investigation — clear
boundaries, no write conflicts. Learn the mechanics before parallel implementation.

**Avoid file conflicts.** Two teammates editing one file = overwrites. Partition file ownership
explicitly in the spawn prompts. *(Critical in this repo — see §0.)*

**Monitor and steer.** Check progress, redirect bad approaches, synthesize as findings arrive.
Unattended teams waste tokens.

---

## 11. Prompt patterns that work

**Parallel code review** — distinct lenses so reviewers don't overlap:
```text
Spawn three teammates to review PR #142:
- One focused on security implications
- One checking performance impact
- One validating test coverage
Have them each review and report findings.
```

**Competing hypotheses** — the adversarial structure is the mechanism. Sequential investigation
anchors on the first plausible theory; independent investigators trying to *disprove* each
other surface the actual root cause.
```text
Users report the app exits after one message instead of staying connected.
Spawn 5 agent teammates to investigate different hypotheses. Have them talk to
each other to try to disprove each other's theories, like a scientific
debate. Update the findings doc with whatever consensus emerges.
```

---

## 12. Troubleshooting

| Symptom | Cause / fix |
| :--- | :--- |
| **Teammates not appearing** | Check the agent panel (↑/↓, Enter). A vanished row is *hidden, not stopped* — message the teammate by name to bring it back; expand `N idle agents` with Enter. Or Claude judged the task too simple for a team — ask again, explicitly. |
| **Split panes not working** | `which tmux`; for iTerm2 verify `it2` is installed and Python API enabled. Not supported in VS Code terminal / Windows Terminal / Ghostty. |
| **Too many permission prompts** | Pre-approve common operations in permission settings before spawning. |
| **Teammate stopped on an error** | Select it → Enter → read its output. Give it new instructions, or spawn a replacement. (v2.1.198+: a message from the lead or a teammate wakes a teammate waiting on an API retry, so it retries immediately.) |
| **Lead shuts down early** | Tell it to keep going / to wait for teammates before proceeding. |
| **Task stuck** | Teammates sometimes fail to mark completion, blocking dependents. Verify the work, then update status manually or tell the lead to nudge. |
| **Orphaned tmux session** | `tmux ls` then `tmux kill-session -t <name>`. |

---

## 13. Known limitations (experimental feature)

- **No session resumption with in-process teammates** — `/resume` and `/rewind` don't restore
  them. After resuming, the lead may try to message teammates that no longer exist; tell it to
  spawn new ones.
- **Task status can lag** — see troubleshooting above.
- **Shutdown can be slow** — teammates finish the current request or tool call first.
- **One team per session** — no additional named teams, no sharing across sessions.
- **No nested teams** — only the lead manages the team.
- **No background subagents from in-process teammates** — `run_in_background` or a subagent
  definition with `background: true` returns an error, since a teammate's background work can't
  outlive the lead's process. Subagents launched from the main conversation are unaffected.
- **Lead is fixed** — no promotion or transfer of leadership.
- **Permissions set at spawn** — changeable after, not at spawn time.
- **Split panes require tmux or iTerm2.**

---

## 14. Checklist before spawning a team

1. Is the work genuinely parallel, or is it sequential/same-file? → sequential means single session.
2. Do the workers need to talk to each other? → no means subagents, not a team.
3. Have I partitioned file ownership so no two teammates touch the same file?
4. Is the team 3–5 teammates with ~5–6 tasks each?
5. Does each spawn prompt carry the task-specific context (the lead's history won't)?
6. Have I named the teammates so I can address them later?
7. Sonnet unless there's a reason for Opus?
8. Are common permissions pre-approved?
9. Does the task warrant ~7× the tokens?

---

## 15. Related

- [Subagents](https://code.claude.com/docs/en/sub-agents) — lightweight in-session delegation
- [Git worktrees](https://code.claude.com/docs/en/worktrees) — manual parallel sessions
- [Hooks](https://code.claude.com/docs/en/hooks) · [Settings](https://code.claude.com/docs/en/settings) · [Costs](https://code.claude.com/docs/en/costs)
