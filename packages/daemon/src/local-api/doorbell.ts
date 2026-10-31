import { z } from 'zod'
import type { LocalApiReply, LocalApiRoute } from './server.js'

/** Ring an agent from another local process: run a turn in a thread, or in a new top-level post. */
export const DoorbellRequestSchema = z.object({
  /** The agent's id or name. */
  agent: z.string().min(1),
  channel: z.string().min(1),
  /** An existing thread to run the turn in; absent ⇒ post `post ?? text` at top level and run there. */
  thread: z.string().min(1).optional(),
  /** The turn's text, as the agent receives it. */
  text: z.string().min(1).max(40_000),
  /** The top-level post that opens a new thread; defaults to `text`. Ignored with `thread`. */
  post: z.string().min(1).max(40_000).optional(),
  /** Which of the agent's integrations to use; defaults to its first. */
  integrationId: z.string().min(1).optional()
})
export type DoorbellRequest = z.infer<typeof DoorbellRequestSchema>

export function doorbellRoute(ring: (req: DoorbellRequest) => Promise<LocalApiReply>): LocalApiRoute {
  return {
    method: 'POST',
    path: '/v1/doorbell',
    async handle({ body }) {
      const parsed = DoorbellRequestSchema.safeParse(body)
      if (!parsed.success) return { status: 400, body: { error: parsed.error.issues.map((i) => i.message).join('; ') } }
      return ring(parsed.data)
    }
  }
}
