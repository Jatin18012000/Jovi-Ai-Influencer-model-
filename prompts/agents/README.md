# Agent prompts

Prompts for specialist agents (research, trends, strategy, ideation, script, visual, qa, publishing, analytics, learning) live here as they are implemented in later phases.

Conventions (shared with `prompts/executive` and `prompts/evaluation`):

- One Markdown file per prompt; loaded by `PromptLibrary` (`src/core/prompts/prompt-library.ts`).
- `{{variable}}` placeholders; rendering fails if a variable is missing.
- Structured inputs are wrapped in XML-style tags (`<goal>…</goal>`) so they are unambiguous to models.
- No secrets, keys or personal data in prompts.
- Prompts ask for concise, auditable summaries — never hidden chain-of-thought.
