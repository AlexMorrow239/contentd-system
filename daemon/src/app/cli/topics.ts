import { Command } from 'commander'
import { rejectTopics, requeueTopic } from '../../features/topics/mutations.js'
import { listTopics } from '../../features/topics/queries.js'
import type { TopicStatus } from '../../features/topics/status.js'
import { parseTopicIds } from './arguments.js'
import { ROOT_OPTION_DESC, printJson, withDb } from './context.js'
export function registerTopicsCommands(program: Command): void {
  // Operator veto (reject) and repair (requeue) over the scouted topic queue.
  // Actions are thin: id validation lives in parseTopicIds, state transitions
  // in the topics DAO.
  const topics = program.command('topics')

  topics
    .command('list')
    .option('--root <path>', ROOT_OPTION_DESC)
    .option('--channel <name>', 'filter by channel')
    .option('--status <status>', 'filter by topic status')
    .action(async (opts: { root?: string; channel?: string; status?: string }) => {
      await withDb(opts, (db) => {
        // An unknown --status matches no rows (the DAO filters verbatim), so the
        // operator sees an empty table rather than an error.
        const rows = listTopics(db, {
          channel: opts.channel,
          status: opts.status as TopicStatus | undefined,
        })
        console.table(
          rows.map((r) => ({
            id: r.id,
            channel: r.channel,
            score: r.score,
            status: r.status,
            title: r.title,
            reason: r.reason,
          })),
        )
      })
    })

  topics
    .command('reject <ids...>')
    .option('--root <path>', ROOT_OPTION_DESC)
    .action(async (rawIds: string[], opts: { root?: string }) => {
      const ids = parseTopicIds(rawIds)
      await withDb(opts, (db) => {
        const changed = rejectTopics(db, ids)
        // reject takes candidate only; claimed/used rows are skipped.
        console.log(`rejected ${changed} of ${ids.length}`)
      })
    })

  topics
    .command('requeue <id>')
    .option('--root <path>', ROOT_OPTION_DESC)
    .action(async (rawId: string, opts: { root?: string }) => {
      // Same pre-db id validation as reject: a bad token throws to the
      // parseAsync .catch (message on stderr, exit 1) with no writes.
      const [id] = parseTopicIds([rawId])
      await withDb(opts, (db) => {
        const outcome = requeueTopic(db, id)
        if (outcome.ok) {
          printJson({ action: 'requeued', topicId: id })
          return
        }
        // Refusals keep the one-JSON-line contract (the guard's details live in
        // the line) and add the human sentence on stderr, mirroring `scout`.
        const refused = { action: 'refused' as const, topicId: id, reason: outcome.reason }
        if (outcome.reason === 'job-active') {
          printJson({ ...refused, jobId: outcome.jobId, jobStatus: outcome.jobStatus })
          console.error(
            `topic ${id} is still held by job ${outcome.jobId} (${outcome.jobStatus}) — resolve that job first`,
          )
        } else if (outcome.reason === 'not-claimed') {
          printJson({ ...refused, status: outcome.status })
          console.error(`topic ${id} is "${outcome.status}", not "claimed" — nothing to requeue`)
        } else {
          printJson(refused)
          console.error(`unknown topic id ${id}`)
        }
        process.exitCode = 1
      })
    })
}
