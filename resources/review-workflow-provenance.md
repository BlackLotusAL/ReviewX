# Review workflow provenance

Reference: https://github.com/anthropics/claude-code/blob/52c76441cae91f6891e4712306bffb057ff6fec5/plugins/code-review/commands/code-review.md

Reference commit: 52c76441cae91f6891e4712306bffb057ff6fec5
ReviewX workflow: native-review/1

The reference repository's LICENSE.md states that it is © Anthropic PBC, all rights reserved, subject to Anthropic's Commercial Terms of Service.
ReviewX does not vendor or redistribute that command text. Its prompts are independently written to implement the high-level four-reviewer and independent-verification workflow.

Adaptations: native OpenCode tasks instead of Claude model-specific routing; any configured default model; CodeHub context supplied by the host; scoped AGENTS.md/CLAUDE.md plus supplemental rules; demonstrable conditional defects included; no automatic PR skipping or comments; structured plain-text fields rendered by deterministic code.
