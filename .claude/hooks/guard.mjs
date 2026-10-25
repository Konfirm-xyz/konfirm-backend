#!/usr/bin/env node
// Claude Code PreToolUse hook: blocks Bash commands that break the project's guardrails before they run.
// Wire it in .claude/settings.json (see the guardrails skill). Reads the hook JSON on stdin; exit 2 + a message on
// stderr blocks the call and tells Claude why. Extra patterns: .claude/guard-rules.json as [{ "pattern", "why" }].
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RULES = [
  { pattern: String.raw`git\s+push\b[^|;&]*\s(-f|--force)(\s|$)`, why: "Force-push rewrites shared history. Push normally or ask the user." },
  { pattern: String.raw`git\s+push\b[^|;&]*\b(origin\s+)?(main|master)\b`, why: "Don't push straight to main. Push a branch and open a PR, unless the user explicitly asked to push main." },
  { pattern: String.raw`git\s+reset\s+--hard`, why: "reset --hard throws away work. Stash or ask first." },
  { pattern: String.raw`git\s+(checkout|restore)\s+(--\s+)?\.(\s|$)`, why: "This discards every uncommitted change. Ask first." },
  { pattern: String.raw`git\s+clean\s+-[a-z]*f`, why: "git clean deletes untracked files. Ask first." },
  { pattern: String.raw`git\s+add\s+[^|;&]*\.env`, why: "Never commit env files. Secrets stay in .env.local / host settings." },
  { pattern: String.raw`rm\s+-[a-z]*r[a-z]*f?\s+(/|~|\$HOME|\.)(\s|$)`, why: "Recursive delete of a root, home or the whole project. Never." },
  { pattern: String.raw`(cat|less|head|tail|printenv)\s+[^|;&]*\.env(\.|\s|$)`, why: "Don't print secrets into the conversation. Refer to variables by name." },
  { pattern: String.raw`(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)`, why: "Destructive database command. Needs the user's explicit go-ahead." },
];

let input = "";
for await (const chunk of process.stdin) input += chunk;
let command = "";
try {
  command = JSON.parse(input)?.tool_input?.command ?? "";
} catch {
  process.exit(0); // not our input shape: don't block
}

const extra = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), ".claude", "guard-rules.json");
const rules = existsSync(extra) ? [...RULES, ...JSON.parse(readFileSync(extra, "utf8"))] : RULES;

for (const r of rules) {
  if (new RegExp(r.pattern, "i").test(command)) {
    process.stderr.write(`Blocked by project guardrails: ${r.why}\n`);
    process.exit(2);
  }
}
process.exit(0);
