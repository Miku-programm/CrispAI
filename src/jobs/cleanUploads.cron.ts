import { Queue, type Job } from "bullmq";
import { connection } from "@/services/redis.service";
import * as storage from "@/services/storage.service";

/**
 * 定期清理客服从 Telegram 发出的旧图片，避免上传目录无限增长。
 * 默认不清理；设置 UPLOAD_RETENTION_DAYS（天数）后才会删除超期文件。
 */
export default {
  name: "cleanUploads.cron",
  queue: new Queue("cleanUploads.cron", {
    connection,
    defaultJobOptions: { removeOnComplete: { count: 30 }, removeOnFail: { count: 30 } },
  }),
  schedule: "30 3 * * *",
  processor: async (job: Job) => {
    const days = storage.uploadRetentionDays();
    if (days === 0) return { success: true, message: "未启用上传清理" };
    const deleted = await storage.deleteFilesOlderThan(days * 24 * 3600 * 1000);
    await job.log(`已清理 ${deleted} 个超过 ${days} 天的上传文件`);
    return { success: true, deleted };
  },
};
