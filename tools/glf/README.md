# Auto-glf — what this is and how to use it

*(The new-user guide. The operator files are: `CRON_PROMPT.md` — the loop's protocol, fired every tick;
`SHORTCUTS.md` — the session paste shortcuts; `HEADLESS_PROMPT.md` — the scheduled grader's constraints.
Deep design + history: `docs/RESEARCH_auto_glf.md`. The bus contract: `../orchard-logs/tests/README.md`.)*

## The one-paragraph mental model

Auto-glf is a **truth loop for shipped code**. When a session fixes or builds something, it writes a *test* — a
one-sentence claim plus greppable evidence rules, registered **before** the evidence exists. A *grader* then
watches real usage traffic (the fleet logs in `../orchard-logs`) every 5 minutes and answers each test with
PASS / FAIL / INCONCLUSIVE, evidence quoted. The point: **"the code changed" stops counting as "the problem is
fixed."** Only live traffic gets to say that — the system's own history proved why (the focus-pin arc passed four
times on mechanism while the user-visible outcome never worked once).

## What runs without you

An OS task (`orchard-auto-glf`, schtasks, every 5 min) grades whenever the machine is on and you're logged in —
via `headless-tick.cmd` → a headless `claude -p` session as the fixed lane **`lane-cron`**. It grades open tests,
delivers results to the bus, and **cannot touch the extension repo** (grade-only: `--permission-mode default` + a
scoped allowlist). You don't start it, feed it, or babysit it. After a sleep it resumes on wake and *names* the
gap it missed (`LOOP GAP <n>min`) rather than pretending nothing happened. Its output: `logs/run/cron.out`.

## Your three touchpoints

**1. Do the `[human]` steps when asked.** Most verifications need a person to trigger the behavior once — reload
the extension, run a workflow, send a particular ask. Tests park as *waiting-human* until you act. The to-do list
is one command:

```
node tools/glf/report.cjs census
```

Quiet grader ticks print it automatically — dead air IS the reminder. Often one action (an extension reload)
clears several items at once.

**2. Start build sessions with a paste shortcut.** New chat, entire first message:

- **`run glf grader`** — the session joins the loop. Normally it becomes a *builder* (the OS task holds the
  grading lease); it takes over grading automatically only if the task goes quiet (3 missed ticks).
- **`run glf builder`** — same, explicitly for a fresh coding session.

The session then, per 5-minute tick, checks its **inbox** (results delivered for tests this session's lane owns)
and acts: a **PASS** retires the question, a **FAIL** means diagnose and fix, right there. That's the cycle:
build → the test states what should now be true → the grader watches real traffic → the verdict returns to the
session that owns it.

**3. Read the dashboard occasionally.**

```
node tools/glf/report.cjs          # duty cycle · scoreboard · census · bus-delivery check
node tools/glf/report.cjs duty     # just "is the loop actually firing"
```

## The two rules that keep it honest

- **Never grade by vibes.** A verdict comes only from the test's pre-registered arms matching real log lines. If
  reality fits no arm, the verdict is "the test is malformed — repair it," never a prose "looks good."
- **Results are append-only; questions close only by their owner.** Disagreeing grades are kept as data, and a
  PASS doesn't retire a test until the lane that wrote it says so.

## What it is not

Not a unit-test runner (`npm test` is the pre-commit gate; this watches *after* shipping). Not an auto-fixer (it
delivers bad news; fixing stays human-initiated — the full-rights variant is deliberately unbuilt, see
`docs/RESEARCH_auto_glf.md` §9). Not cloud magic — ~1,700 lines of scripts here plus a git repo of scrubbed logs.

**Day one in practice:** you do nothing. The task grades on its own; build-chats handle the bus for you; every so
often you run the census and knock out the `[human]` steps. That's the entire user manual.
