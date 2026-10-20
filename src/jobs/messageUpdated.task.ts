import * as db from "@/services/db.service";
import { Queue } from "bullmq";
import { connection } from "@/services/redis.service";
import messageSendTask from "@/jobs/messageSend.task";

/** Picker selections are customer inquiries too, so they obey the same block and takeover policy. */
export default {
  name: "messageUpdated.task",
  queue: new Queue("messageUpdated.task", { connection }),
  processor: async (job: any) => {
    const { website_id, session_id, content } = job.data;
    const project = await db.getProject(website_id);
    if (!project || !content?.id || await db.isSessionBlocked(website_id, session_id)) {
      return { skipped: true };
    }
    const card = (await db.getOption(project.id)).find(o => o.id === content.id);
    if (!card) return { skipped: true };
    for (const choice of content.choices ?? []) {
      if (!choice.selected) continue;
      const option = card.options.find((o: any) => o.id === choice.value);
      if (!option) continue;
      await messageSendTask.processor({
        timestamp: job.timestamp,
        data: {
          website_id, session_id, type: "text", content: option.label,
          option_trigger: option.trigger, _received_at: job.data._received_at,
        },
      });
    }
    return { success: true };
  },
};
