/**
 * Pure mode data and helpers for the agent-modes extension, kept in their own
 * dependency-light module so other extensions (codebase-tour) and the test
 * harness can import them without pulling in index.ts's runtime deps
 * (@earendil-works/pi-coding-agent, the subagent discovery module), which
 * aren't resolvable outside the pi runtime's own module loader.
 */

/**
 * A mode bundles the policies that govern how autonomously the agent behaves:
 * - which built-in tools are available (e.g. edit/write removed in pair mode)
 * - whether git write commands (commit/push) are allowed
 * - a system prompt snippet describing the mode's behavior to the model
 */
export interface AgentMode {
  name: string;
  label: string;
  description: string;
  editPolicy: "blocked" | "confirm" | "unrestricted";
  gitWritePolicy: "blocked" | "confirm" | "unrestricted";
  systemPromptSnippet: string;
}

export const COORDINATOR_BASE_SNIPPET =
  "You are in COORDINATOR mode. You are a coordinator, not an implementer:\n" +
  "- Do not do substantial thinking, research, or implementation work yourself. " +
  "Break the user's request into concrete tasks and delegate each one to a " +
  "subagent (the subagent tool). Let subagents do the heavy lifting.\n" +
  "- Built-in file edit/write and git commit/push are blocked for you directly in " +
  "this mode - that is intentional. Have a subagent make file changes and commits; " +
  "only use light read-only tools yourself to route work or sanity-check results.\n" +
  "- If a subagent's response contains a question, asks for clarification, or " +
  "seems unsure how to proceed, do NOT answer on its behalf and do NOT guess. Stop, " +
  "relay the question to the user (ask them directly), and wait for their answer " +
  "before resuming or re-dispatching the subagent.\n" +
  "- Default to self-doubt: assume your own unaided judgement is more likely wrong " +
  "than a subagent's focused output or the user's clarification. Prefer verifying " +
  "through a subagent, or checking with the user, over confidently asserting an " +
  "answer yourself.\n" +
  "- When unsure whether something needs user input or another subagent, err on the " +
  "side of asking rather than proceeding unilaterally.\n" +
  "- Default to one-shot delegation (single/parallel/chain) - it's simpler and " +
  "leaves no stale state behind. Reach for persistent open/send/close only for " +
  "genuine multi-turn work against the same accumulated context, e.g. iterative " +
  "code review: open a reviewer on a diff, dispatch a one-shot worker to make " +
  "fixes, then send the updated diff back to that same reviewer handle to verify " +
  "the prior findings. Close a session once its work is done; use list if you " +
  "lose track of a handle; never invent or guess a handle - only use ones " +
  "returned by open or list.";

export const MODES: Record<string, AgentMode> = {
  pair: {
    name: "pair",
    label: "Pair Coding",
    description:
      "Design-first pairing: the user drives design decisions and the agent helps think. " +
      "Built-in edits and git writes stay blocked; confirmed changes are applied via a worker " +
      "subagent, a mode switch, or by the user.",
    editPolicy: "blocked",
    gitWritePolicy: "blocked",
    systemPromptSnippet:
      "You are in PAIR CODING mode. The user is the driver of design decisions; you help them think, you do not decide for them.\n" +
      "- When a new problem or subproblem comes up, ask for the user's approach first, then react to it " +
      "(gaps, alternatives, trade-offs) instead of presenting your own solution up front.\n" +
      "- Explain concepts directly when asked or when they unblock a decision, but leave consequential " +
      "decisions (architecture, interfaces, data shapes, trade-offs) open for the user to make.\n" +
      "- Work through three checkpoints and name the one you are at: Understanding (the problem and " +
      "constraints are agreed), Design (the approach is agreed), Implementation (the agreed design is " +
      "being turned into code). Do not move to the next checkpoint without the user's explicit confirmation.\n" +
      "- Before design confirmation, short illustrative snippets (roughly 15 lines or fewer each) are fine " +
      "to make an idea concrete. Do not write full implementation code until the user has explicitly " +
      "confirmed the design.\n" +
      "- After confirmation, you may show full code in chat for the user to review.\n" +
      "- If there are details the user did not decide, list them as a table with the columns " +
      "Detail | Proposal | Why it matters, and let the user accept or change each one.\n" +
      "- Built-in edit/write and git commit/push are blocked in this mode, intentionally. To apply a " +
      "confirmed change, either delegate it to a subagent (once the user agrees), or tell the " +
      "user they can switch with /mode guarded --session or /mode auto --session, or make the edit themselves.\n" +
      "- Never work around the block: no bash redirects, sed -i, tee, heredocs, git apply, scripted " +
      "writes, or similar tricks to modify files or history.\n" +
      "- Adaptive preferences: follow any saved pair preferences shown below. The user's current " +
      "instructions always override them. When you notice a stable collaboration-style preference " +
      "(e.g. how much explanation, snippet size, how to present options), propose saving it with the " +
      "pair_preference tool, which asks the user to confirm. Never save task-specific or one-off requests.",
  },
  guarded: {
    name: "guarded",
    label: "Guarded Auto",
    description:
      "Work autonomously, but ask before editing/writing files or running git write commands.",
    editPolicy: "confirm",
    gitWritePolicy: "confirm",
    systemPromptSnippet:
      "You are in GUARDED AUTO mode. Work autonomously on investigation, design, and review. " +
      "Before editing or writing files, committing, pushing, or running other git write commands, " +
      "request approval through the tool confirmation flow. If approval is denied, explain the " +
      "blocked action and ask how to proceed.",
  },
  auto: {
    name: "auto",
    label: "Full Auto",
    description:
      "Fully autonomous: design, implement, review, and commit without needing to check in.",
    editPolicy: "unrestricted",
    gitWritePolicy: "unrestricted",
    systemPromptSnippet:
      "You are in FULL AUTO mode. Act autonomously: design, implement, review, and " +
      "commit/push as needed to complete the task, unless the user's prompt asks you " +
      "to be more careful.",
  },
  coordinator: {
    name: "coordinator",
    label: "Coordinator",
    description:
      "Delegate work to subagents instead of doing it yourself; escalate subagent " +
      "questions to the user; err on the side of self-doubt.",
    editPolicy: "blocked",
    gitWritePolicy: "blocked",
    // Static fallback only - the live snippet actually injected each turn is
    // computed fresh by buildCoordinatorSnippet() in index.ts so it can include
    // an up-to-date list of real subagent names.
    systemPromptSnippet: COORDINATOR_BASE_SNIPPET,
  },
  tour: {
    name: "tour",
    label: "Codebase Tour",
    description:
      "Guided, read-only walkthrough of the codebase. No edits or git writes; use the " +
      "codebase-tour extension's tools to plan, advance, and record notes.",
    editPolicy: "blocked",
    gitWritePolicy: "blocked",
    systemPromptSnippet:
      "You are in CODEBASE TOUR mode. You are guiding the user through a read-only, " +
      "structured walkthrough of this codebase:\n" +
      "- Built-in file edit/write and git commit/push are blocked for you in this mode - " +
      "that is intentional. If the user wants an actual change made, tell them to switch " +
      "modes (e.g. /mode pair or /mode auto) rather than trying to work around the block.\n" +
      "- Use the codebase-tour extension's tools (tour_plan, tour_advance, tour_note, tour_show, " +
      "tour_status, tour_end) to plan and track the tour - don't just narrate a walkthrough " +
      "from memory without recording it, or the user loses their place if the session ends.\n" +
      "- Teaching style is mixed Socratic/explain-first: explain what a stop's code does and " +
      "why it's shaped that way, then ask a short question that checks understanding or " +
      "invites the user to predict/explore before moving on - don't just lecture, and don't " +
      "just quiz. Read the user's signals (short answers, 'just tell me', deep follow-ups) " +
      "and shift the balance accordingly. See the codebase-tour skill for the full loop.\n" +
      "- If a tour is already in progress (see the injected tour status), resume it at its " +
      "current stop instead of restarting from scratch - unless the user explicitly asked for " +
      "a new one (e.g. by running /tour start, whose kickoff message says so), in which case " +
      "start fresh and replace it.",
  },
};

export const DEFAULT_MODE = "pair";

/**
 * Env var the parent pi process sets to its current mode, so spawned subagents (which
 * inherit the parent's environment) know what they were dispatched from. Set by index.ts.
 */
export const PARENT_MODE_ENV = "PI_PARENT_AGENT_MODE";

/** Parent modes whose subagents may run git write commands (coordinator relies on it). */
const SUBAGENT_GIT_WRITE_PARENTS = new Set(["auto", "coordinator"]);

/**
 * The mode a pi-runtime subagent (PI_SUBAGENT=1) runs in, derived from the parent's mode.
 *
 * Subagents must not inherit the parent's mode as-is: coordinator, pair and tour block
 * edits, so a worker dispatched from them could not do its job - and coordinator mode exists
 * precisely to hand edits to subagents. Edits are therefore unrestricted; what a subagent can
 * touch is decided by its agent definition's `tools:` list. Git writes are allowed only when
 * the parent itself would allow them without asking (auto) or delegates them by design
 * (coordinator). Otherwise they are blocked outright: a subagent has no UI, so "confirm"
 * could never be approved, and pair/tour mean the user has not handed over commits.
 */
export function subagentMode(parentMode: string | undefined): AgentMode {
  const parent = parentMode && MODES[parentMode] ? parentMode : DEFAULT_MODE;
  const gitWrites = SUBAGENT_GIT_WRITE_PARENTS.has(parent);
  return {
    name: "subagent",
    label: "Subagent",
    description: `Delegated task runner (dispatched from ${MODES[parent].label} mode).`,
    editPolicy: "unrestricted",
    gitWritePolicy: gitWrites ? "unrestricted" : "blocked",
    systemPromptSnippet:
      "You are running as a delegated SUBAGENT: another agent gave you this task and will read " +
      "your final reply. Nobody can answer questions mid-task. Complete the task as given; if it " +
      "is ambiguous or blocked, stop and state what you need in your final reply instead of " +
      "guessing. " +
      (gitWrites
        ? "Commit only if the task asks you to."
        : "Git write commands (commit/push/merge/rebase) are blocked; leave changes uncommitted."),
  };
}

/** Name of the read-only tour mode, exported so other extensions (codebase-tour) don't have to hardcode it. */
export const TOUR_MODE_NAME = "tour";

/** Flag on /mode that switches for the current session only, without persisting as the default for future sessions/projects. */
export const SESSION_ONLY_FLAG = "--session";

export interface ModePolicy {
  editPolicy: AgentMode["editPolicy"];
  gitWritePolicy: AgentMode["gitWritePolicy"];
}

/**
 * Pure lookup of a mode's edit/git-write policy, exported so other extensions and tests can
 * verify what a mode actually enforces (e.g. that tour mode blocks edits) instead of relying on
 * a hardcoded mode name string staying in sync by convention.
 */
export function getModePolicy(name: string): ModePolicy | undefined {
  const mode = MODES[name];
  if (!mode) return undefined;
  return { editPolicy: mode.editPolicy, gitWritePolicy: mode.gitWritePolicy };
}

/**
 * Pure parse of `/mode` command args: a mode name plus an optional SESSION_ONLY_FLAG.
 * Unknown `--flags` (e.g. a typo like `--sesion`) are reported as an error rather than
 * silently ignored - persist defaults to true, so a typo'd flag would otherwise fail open
 * into persisting the mode switch as the default for every future session/project, which
 * is the opposite of what someone typing a `--session`-like flag wants.
 */
export function parseModeArgs(args: string): { name: string; persist: boolean; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const unknownFlags = tokens.filter((t) => t.startsWith("--") && t !== SESSION_ONLY_FLAG);
  if (unknownFlags.length > 0) {
    return {
      name: "",
      persist: true,
      error: `Unknown flag(s): ${unknownFlags.join(", ")}. The only supported flag is ${SESSION_ONLY_FLAG}.`,
    };
  }
  const persist = !tokens.includes(SESSION_ONLY_FLAG);
  const name = (tokens.find((t) => !t.startsWith("--")) ?? "").toLowerCase();
  return { name, persist };
}

/** customType of the hidden one-turn intent hint message injected by index.ts. */
export const INTENT_HINT_CUSTOM_TYPE = "agent-intent-hint";

export type SubagentIntent = "devils-advocate" | "worker";

const DELEGATION_GUIDANCE_MODES = new Set(["pair", "guarded", "auto"]);

/**
 * Optional delegation suggestions for the non-coordinator working modes, limited to agents that
 * actually exist. Empty for other modes (coordinator already delegates; tour is read-only teaching).
 */
export function buildDelegationGuidance(modeName: string, available: readonly string[]): string {
  if (!DELEGATION_GUIDANCE_MODES.has(modeName)) return "";
  const has = (name: string) => available.includes(name);
  const lines: string[] = [];
  if (modeName === "pair" && has("worker")) {
    lines.push(
      "- To apply a design the user has confirmed, offer to dispatch the `worker` subagent with the agreed design; only dispatch after the user says yes.",
    );
  }
  if (has("scout")) {
    lines.push(
      "- For broad read-only lookups (finding where something lives, tracing usages), consider the `scout` subagent instead of searching yourself.",
    );
  }
  if (has("reviewer")) {
    lines.push(
      "- For a second opinion on a non-trivial diff or design, consider the `reviewer` subagent.",
    );
  }
  if (lines.length === 0) return "";
  if (modeName === "pair") {
    lines.push(
      "- Subagents do not override this mode and must not edit files until the user has confirmed the design and asked for it to be applied.",
    );
  }
  return `Optional subagent delegation (the subagent tool):\n${lines.join("\n")}`;
}

/** A negation word within a few words before a trigger, i.e. one that negates the trigger itself. */
const NEGATION_BEFORE =
  /\b(?:don['’]?t|do not|dont|never|no need(?: for| to)?|no|without|not|instead of|rather than)\b(?:\s+[\w'’-]+){0,3}\s*$/i;

// Requests must be phrased as an instruction at the start of a clause, so prompts that merely
// mention workers or devil's advocates ("what does the worker agent do", "fix the devils-advocate
// prompt") and possessives ("the worker's output") do not fire.
const REQUEST_LEAD =
  "^\\s*(?:(?:please|just|now|then|and|also|so|ok|okay)\\s+|(?:let['’]?s|let us)\\s+|(?:(?:can|could|would|will)\\s+you|you\\s+(?:should|can|could|must)|i\\s+(?:want|need|['’]?d\\s+like)\\s+you\\s+to)\\s+(?:please\\s+)?)*";
const DEVILS_ADVOCATE = "devil['’]?s[\\s-]+advocate\\b";
const DEVILS_ADVOCATE_PATTERNS = [
  new RegExp(
    REQUEST_LEAD + "(?:play|be|act\\s+as|give\\s+me|get\\s+me|use|have|do)\\s+(?:a\\s+|an\\s+|the\\s+|some\\s+)?" + DEVILS_ADVOCATE,
    "i",
  ),
  new RegExp("^\\s*(?:please\\s+)?i\\s+(?:want|need|would\\s+like|['’]?d\\s+like)\\s+(?:a|an|some)\\s+" + DEVILS_ADVOCATE, "i"),
  new RegExp(REQUEST_LEAD + "(?:poke\\s+holes|argue\\s+against)\\b", "i"),
];

const WORKER_NOUN = "(?:a\\s+|the\\s+|one\\s+)?(?:subagent\\s+)?worker(?:\\s+(?:subagent|agent))?(?![\\w'’-])(?!\\s+(?:thread|process|pool|queue|for\\s+each|per))";
// "send" is common in code instructions ("send messages to the worker"), so it needs an explicit
// task-like object; dispatch/delegate/hand off are unambiguous.
const SEND_OBJECT = "(?:this|that|it|the\\s+(?:task|job|work|change|changes|refactor|fix|implementation))";
// use/have/launch/spawn are ordinary coding verbs ("have the worker retry"), so they need the noun
// to say subagent/agent explicitly, or name the `worker` agent in backticks.
const EXPLICIT_WORKER_NOUN =
  "(?:a\\s+|the\\s+|one\\s+)?(?:`worker`|(?:subagent\\s+worker|worker\\s+(?:subagent|agent))(?![\\w'’-]))";
const WORKER_PATTERNS = [
  new RegExp(REQUEST_LEAD + "(?:use|have|launch|spawn)\\s+" + EXPLICIT_WORKER_NOUN, "i"),
  new RegExp(
    REQUEST_LEAD + "(?:dispatch|delegate|hand(?:\\s+(?:it|this|that))?\\s+off)\\b[^,;]*\\bto\\s+" + WORKER_NOUN,
    "i",
  ),
  new RegExp(REQUEST_LEAD + "send\\s+" + SEND_OBJECT + "\\s+to\\s+" + WORKER_NOUN, "i"),
];

function triggers(clause: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => {
    const m = p.exec(clause);
    return m !== null && !NEGATION_BEFORE.test(clause.slice(0, m.index)) && !NEGATION_BEFORE.test(m[0]);
  });
}

/**
 * Explicit subagent requests found in a user prompt. Works clause by clause, and a clause is
 * suppressed only when a negation sits just before the trigger ("don't use a worker", "no
 * devil's advocate needed"), not when it merely appears elsewhere in the clause. Returns a
 * de-duplicated, fixed order.
 */
export function detectSubagentIntents(prompt: string): SubagentIntent[] {
  const found = new Set<SubagentIntent>();
  const clauses = prompt.split(/[.!?;,\n]+/);
  for (const clause of clauses) {
    if (triggers(clause, DEVILS_ADVOCATE_PATTERNS)) found.add("devils-advocate");
    if (triggers(clause, WORKER_PATTERNS)) found.add("worker");
  }
  return (["devils-advocate", "worker"] as const).filter((i) => found.has(i));
}

/**
 * One-turn hint for explicitly requested subagents. Drops agents that are not available, and
 * worker in tour mode (read-only). Empty string when nothing remains.
 */
export function buildIntentHint(
  intents: readonly SubagentIntent[],
  modeName: string,
  available: readonly string[],
): string {
  const lines: string[] = [];
  if (intents.includes("devils-advocate") && available.includes("devils-advocate")) {
    lines.push(
      "- The user asked for a devil's advocate: dispatch the `devils-advocate` subagent to challenge the current plan or conclusion, then report its objections.",
    );
  }
  if (intents.includes("worker") && modeName !== TOUR_MODE_NAME && available.includes("worker")) {
    const planner = available.includes("planner")
      ? " If the task is not yet well specified, consider the `planner` subagent first."
      : "";
    lines.push(
      `- The user asked for a worker: dispatch the \`worker\` subagent with a self-contained task.${planner}`,
    );
  }
  if (lines.length === 0) return "";
  return `Hidden hint for this turn only (the user did not see this):\n${lines.join("\n")}`;
}
