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
      "Design and discuss together. Never edit files or commit/push without explicit user permission.",
    editPolicy: "blocked",
    gitWritePolicy: "blocked",
    systemPromptSnippet:
      "You are in PAIR CODING mode. Spend time designing with the user, offering " +
      "suggestions, and proposing code snippets. Do not edit or write files, and do " +
      "not commit or push, unless the user explicitly asks you to.",
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
