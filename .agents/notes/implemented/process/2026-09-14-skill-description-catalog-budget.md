# Agent Note: Keep skill descriptions inside the model-facing catalog budget

Status: implemented

English | [中文](2026-09-14-skill-description-catalog-budget.zh.md)

## Problem

`dsh-tool-skill` renders the session skill catalog with `catalogDescriptionMaxLength` (default 500) and hard-truncates any longer description with an ellipsis. Truncation happens at render time against an intact source file, so review cannot see it, and what it removes is the tail — which is where a description conventionally states when the skill applies.

Two repository skills exceeded the limit. `record-browser-gif` (569 characters) lost the half-sentence carrying its hard requirement that every product-user-visible GUI pull request includes a GIF recorded from the real server and model flow. `dsh-doc` (518) lost the end of its `Use for` list. Both remained valid Markdown, passed every gate, and reached the model with their selection signal cut off.

The catalog also had no aggregate bound. `catalogDescriptionMaxLength` caps one description; nothing caps their sum, even though the rendered catalog is paid on every request.

## Decision

`scripts/verify-skill-descriptions.ts` gates repository skill descriptions, registered as `verify-skill-descriptions` and as the `skill-descriptions` leaf of `doc-sync` and `doc-quick`. It enforces four rules:

- Every `.agents/skills/*/SKILL.md` description stays at or under **450 characters** — the 500-character render limit less 50 characters of headroom, so ordinary rewording cannot silently cross it.
- Each description states when to use the skill (`Use when`, `Use before`, `Use for`, or `Use to`), or states its boundary instead (`Do not use`).
- Descriptions naming another repository skill also carry boundary language, so a cross-reference disambiguates rather than duplicating.
- Descriptions together stay within a **4500-character** catalog budget, and no two descriptions share more than half of their distinctive words.

All twelve repository descriptions were rewritten to satisfy the rules, dropping implementation detail (tool names, flag names, encoding steps) that belongs in the skill body rather than in the selection signal. The longest is now 412 characters and the total is 3925.

`AGENTS.md` also carried a duplicate pointer: a standalone sentence restating the persistence-type acknowledgement duty that its own preceding paragraph already linked. The duty moved into that paragraph's link text and the standalone sentence was removed at no word cost.

### Subtraction audit outcome

The same review checked the repository's model-facing prose for the three forms of stale guidance that a more capable model makes unnecessary: encouragement to run tests and verify work, blanket obligations to read files before acting, and strong ask-first permission language written to restrain an earlier model. A pattern sweep over `AGENTS.md`, `docs/`, `packages/AGENTS.md`, and `.agents/skills/` found the first and third forms absent entirely. The second form appears only as contextual routing — `AGENTS.md` scopes the architecture read to `packages/` changes, and `docs/architecture.md` restates the same scope rather than demanding a pre-read of everything. The two testing lines in `AGENTS.md` constrain testing rather than encourage it, and no other file states them, so neither is stale. The duplicate pointer above was the only removal the audit justified.

## Alternatives considered

**Keep truncating at render time and rely on review.** Rejected: the failure is invisible by construction. The source file is intact and every existing gate passes, so only a gate that measures the rendered length can catch it. The two over-limit descriptions had been shipping in this state.

**Raise `catalogDescriptionMaxLength` instead of shortening descriptions.** Rejected: it treats the symptom. The length is not the defect; putting implementation detail in a selection signal is. A larger cap also lets the catalog grow without bound, which is the second gap.

**Trim descriptions without adding a gate.** Rejected: the condition would return with the next skill. The repository already treats recurring conditions as gates rather than as one-off cleanups, and `doc-budgets.manifest.json` is the established shape for a prose budget.

**Port Codex's aggregate behavior: shorten every description, then omit entries with a warning.** Not done. Their initial skill list is bounded at 2% of the context window or 8000 characters, and degradation is graduated and announced. Reaching that shape needs renderer changes in `dsh-tool-skill` and a design decision about what the model should be told when a skill is withheld. The budget gate bounds the total in the meantime and fails at the source, where the fix is cheap.

**Enforce a per-skill `disable-model-invocation` policy for error-prone skills.** Not needed: the repository already implements it in `skill-filesystem` and cross-checks it against Codex's `policy.allow_implicit_invocation` in `verify-skill-invocation-metadata`. No repository skill currently needs it.

## Consequences

A description that would truncate now fails at the source, naming the skill, its length, and the limit. A trigger-less description and a duplicated claim between two skills fail the same way. The catalog can no longer grow silently: adding a thirteenth skill beyond the budget requires condensing an existing description in the same change, which is the intended friction and is visible in review.

The 450-character ceiling is tighter than what the renderer permits, so a legitimate need for a longer description becomes a deliberate policy question — raise the gate constant with justification, as `verify-doc-budgets` ceilings require — rather than an accident. The pairwise overlap rule is a heuristic on stopword-filtered words; it flags descriptions that claim the same work but cannot judge whether two adjacent skills are genuinely distinct, so its threshold is a judgement call recorded here rather than a derived value.

The used total is printed on every run, so the remaining budget is visible without reading source. The twelve rewrites also lengthened slightly the prose removed from `AGENTS.md`: the persistence-type pointer now carries its own verb, so the change is word-neutral rather than a net reduction.
