import * as db from "@/services/db.service";
import * as telegram from "@/services/telegram.service";
import { Queue } from "bullmq";
import path from "path";
import { connection } from "@/services/redis.service";

const currentFileName = path.basename(
  import.meta.url,
  path.extname(import.meta.url)
);
export default {
  name: currentFileName,
  queue: new Queue(currentFileName, {
    connection,
    defaultJobOptions: {
      // 任务成功完成后，只保留最新的 100 条（或 1000 条，看你需要）
      removeOnComplete: {
        count: 100,
        age: 24 * 3600, // (可选) 同时限制时间，例如只保留24小时内的
      },
      // 任务失败后，保留最新的 1000 条以便排查错误
      removeOnFail: {
        count: 100,
      },
    },
  }),
  concurrency: 100,
  processor: async (job: any) => {
    // New callbacks apply control at ingress, then serialize only the presentation update.
    if (typeof job.data === "object") {
      const session = await db.getSession(job.data.session_id);
      if (session) await telegram.refreshSessionControls(session);
    } else {
      // Previously persisted callbacks retain their old string shape.
      const match = /^(open|close)_(-?\d+)_(\d+)$/.exec(job.data);
      if (match) {
        const session = await db.getSessionByTopic(Number(match[2]), Number(match[3]));
        if (session) {
          await telegram.applySessionControl(session, match[1]!);
          await telegram.refreshSessionControls(session);
        }
      }
    }
    return { success: true };
  },
};
