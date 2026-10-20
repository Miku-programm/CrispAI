import { Queue } from "bullmq";
import * as db from "@/services/db.service";
import { connection } from "@/services/redis.service";
import { enqueue } from "@/utils/queue";
import timeoutTask from "@/jobs/supportTimeout.task";

/** Recovers the DB -> Redis handoff after a Redis outage; duplicate jobs are harmless by pending_token. */
export default {
  name: "supportRecovery.cron",
  queue: new Queue("supportRecovery.cron", { connection }),
  schedule: "* * * * *",
  processor: async () => {
    for (const session of await db.listPendingSessions()) {
      await enqueue(timeoutTask.queue, "supportTimeout", {
        website_id: session.website_id, session_id: session.session_id, token: session.pending_token,
      }, { jobId: `recover-${session.pending_token}-${Math.floor(Date.now() / 60_000)}` });
    }
    return { success: true };
  },
};
