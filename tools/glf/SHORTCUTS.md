# glf session shortcuts

Paste one of these as the **entire** first message in a new chat. The agent expands them; do not paste the expansion.

| Paste | Role |
|---|---|
| `run glf grader` | Grader (or dual-role if it wins the lease) |
| `run glf builder` | Builder — new lane, expects lease refused → STEP 0b inbox |

Both arm the same 5-minute loop pointed at [`CRON_PROMPT.md`](CRON_PROMPT.md) (the file, never a copy of its text) and start with `node tools/glf/tick.cjs`.

Alias (deprecated): `run auto glf` → same as `run glf grader`.

## Expansion — `run glf grader`

1. Mint a lane once this session (`node tools/glf/testbus.cjs lane`) unless this chat already has one; reuse it every tick.
2. Arm a recurring 5-minute job whose prompt is: read `tools/glf/CRON_PROMPT.md` in full and follow it, starting with `node tools/glf/tick.cjs`.
3. Run that prompt once now.
4. On each tick follow the prompt: claim lease → grade if claimed, else STEP 0b builder mode.

## Expansion — `run glf builder`

1. Mint a **fresh** lane (`node tools/glf/testbus.cjs lane`). Never reuse another chat's lane (including `lane-8289`).
2. Arm the same 5-minute job as above (point at `CRON_PROMPT.md`).
3. Run once now. Expect `LEASE ▸ REFUSED` → STEP 0b → `inbox --owner <lane>`.
4. Do not grade and do not write `results/` while refused. Act only on inbox items for tests this lane owns (or adopt/write new ones).
5. Reply briefly each tick: lease refused + inbox empty/acted.
