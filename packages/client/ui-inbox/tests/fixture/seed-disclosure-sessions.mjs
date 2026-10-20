#!/usr/bin/env node
/**
 * Seed two conversations into a fresh keyless fixture home, so the reload probe
 * can measure per-conversation disclosure against REAL host state.
 *
 * Why seed instead of stubbing: the plan strip renders from the host's `todos`
 * projection of a `todo/write` event, and a keyless fixture calls no model, so
 * no such event exists to expand. The `?fixture` wire client does ship a
 * transcript with a plan, but the composer is taken over there by the fixture's
 * resident pending question, and the only plan strip in the DOM is the hidden
 * `data-chain-overlay-fallback` copy — measuring a 0×0 hidden node would not be
 * evidence. Writing real session logs into the fixture's isolated DSH_HOME keeps
 * every layer real: the host parses them, computes the projection, and the
 * client renders it through its normal path.
 *
 * Session log format (as the host writes it): one independently-compressed
 * zstd frame per JSONL line, newline included — the reader rejects a log whose
 * first frame is anything but exactly one header line.
 *
 * Usage: node seed-disclosure-sessions.mjs <fixtureDir>
 * Env: DSH_FIXTURE_CWD overrides the workspace path recorded in the header
 *      (default: the checkout this script lives in).
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEEDED_PLANS, SEEDED_SESSIONS } from './seeded-sessions.mjs'

const fixtureDir = process.argv[2]
if (fixtureDir === undefined) {
  console.error('usage: node seed-disclosure-sessions.mjs <fixtureDir>')
  process.exit(2)
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const cwd = process.env.DSH_FIXTURE_CWD ?? repoRoot

/** The DSH_HOME session bucket for a cwd: `/a/b-c` -> `--a-b-c--`. */
function bucketFor(path) {
  return `--${path.replace(/^\//, '').replaceAll('/', '-')}--`
}

function writeLog(dir, events) {
  const scratch = mkdtempSync(join(tmpdir(), 'seed-frames.'))
  try {
    const frames = events.map((event, index) => {
      const source = join(scratch, `${index}.jsonl`)
      // Trailing newline matters: the header frame must be exactly one line.
      writeFileSync(source, `${JSON.stringify(event)}\n`)
      const frame = join(scratch, `${index}.zst`)
      execFileSync('zstd', ['-q', '-f', '-o', frame, source])
      return readFileSync(frame)
    })
    const target = join(dir, 'session.jsonl.zstd')
    writeFileSync(target, Buffer.concat(frames))
    return target
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const bucket = join(fixtureDir, 'home', 'sessions', bucketFor(cwd))
const now = Date.now()
for (const [sessionId, plan] of Object.entries(SEEDED_PLANS)) {
  mkdirSync(join(bucket, sessionId), { recursive: true })
  const events = [
    {
      type: 'session', version: 0, id: sessionId,
      createdAt: now - 60_000, cwd, delegationDepth: 0, agentPreset: 'standard',
    },
    { type: 'permission/preset', seq: 0, time: now - 55_000, data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', seq: 1, time: now - 55_000, data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', seq: 2, time: now - 55_000, data: { policy: 'never' } },
    { type: 'turn/start', seq: 3, time: now - 50_000, data: { turn: 1 } },
    {
      // The identified-message shape the session log requires: a plain
      // {content} payload is refused at read time ("event lacks an identified
      // message"), which is exactly how a hand-written log gets caught.
      type: 'user/message', seq: 4, time: now - 50_000,
      data: {
        role: 'user',
        id: randomUUID(),
        source: { kind: 'user' },
        content: [{ type: 'text', text: `seed: plan strip for ${sessionId}` }],
      },
      // Surface-eligible events carry their fold marker; without it the reader
      // refuses the log rather than guessing how to replay the event.
      surfaceOp: 'append',
    },
    {
      type: 'todo/write', seq: 5, time: now - 40_000,
      data: {
        todos: plan.map((content, index) => ({
          content,
          status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
        })),
      },
    },
    { type: 'turn/end', seq: 6, time: now - 30_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  console.log(`seeded ${sessionId}: ${writeLog(join(bucket, sessionId), events)}`)
}
console.log(`bucket: ${bucket}`)
