import { SQL } from "bun";
import path from "path";
import logger from "@/services/logger.service";
import { parseSupportConfig, type SupportConfig } from "@/types/support";
import { trimThread } from "@/utils/thread";

/**
 * Postgres 服务封装
 *
 * 说明：通过环境变量 `DATABASE_URL` 连接 Postgres（需要 pgvector 扩展），导出常用的查询函数。
 *
 * 写 SQL 时注意两点（都实测过）：
 * - bigint 列（telegramId / group_id / topic_id / message_id）驱动返回的是字符串，
 *   Telegram API 需要数字，所以读出来统一过一遍 toProject / toSession
 * - jsonb 列一律用 `sql({...})` 写入。`${JSON.stringify(x)}::jsonb` 会被二次编码成 JSON 字符串
 */
const sql = new SQL(
  Bun.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/crispai",
);

/**
 * 执行 db/schema.sql 建表。脚本可重复执行，每次启动都跑一遍。
 * 数据库容器可能比应用晚就绪，所以带重试；最终连不上就抛错，交给调用方决定
 */
export const migrate = async (retries = 30, interval = 2000) => {
  const schema = await Bun.file(
    path.join(import.meta.dir, "../../db/schema.sql"),
  ).text();
  for (let i = 1; ; i++) {
    try {
      await sql.unsafe(schema);
      logger.info("数据库结构已就绪");
      return;
    } catch (error) {
      if (i >= retries) throw error;
      logger.warn(`数据库暂不可用，${interval / 1000} 秒后重试 (${i}/${retries})`, {
        message: error instanceof Error ? error.message : String(error),
      });
      await Bun.sleep(interval);
    }
  }
};

const toNumber = (value: unknown) =>
  value === null || value === undefined ? value : Number(value);

const toProject = (row: any) => {
  if (!row) return null;
  row.telegramId = toNumber(row.telegramId);
  row.support = parseSupportConfig(row.support);
  return row;
};

const toSession = (row: any) => {
  if (!row) return null;
  row.group_id = toNumber(row.group_id);
  row.topic_id = toNumber(row.topic_id);
  row.message_id = toNumber(row.message_id);
  return row;
};

// 去掉值为 undefined 的键，避免把没传的字段更新成 null。
// 对话历史在这里统一限长，所有写入路径都不会让它无限增长
const clean = (patch: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) =>
        key === "thread" && Array.isArray(value) ? [key, trimThread(value)] : [key, value],
      ),
  );

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

/**
 * 根据 website_id 获取项目配置，未找到或 `enabled` 为假时返回 `null`
 */
export const getProject = async (website_id: string) => {
  const [row] = await sql`
    select * from project where "websiteId" = ${website_id} limit 1`;
  if (!row || !row.enabled) return null;
  return toProject(row);
};
export const getProjectById = async (id: string) => {
  const [row] = await sql`select * from project where id = ${id} limit 1`;
  return toProject(row);
};
export const listProjects = async (): Promise<any[]> => {
  const rows = await sql`select * from project order by created_at asc`;
  return rows.map(toProject);
};
export const createProject = async (name: string) => {
  const [row] = await sql`
    insert into project ${sql({ name: name || "Untitled" })} returning *`;
  return toProject(row);
};
export const updateProject = async (
  id: string,
  patch: Record<string, unknown>,
) => {
  const data = clean(patch);
  if (Object.keys(data).length === 0) return getProjectById(id);
  const [row] = await sql`
    update project set ${sql(data)} where id = ${id} returning *`;
  return toProject(row);
};
export const deleteProject = async (id: string) => {
  // option / payload 靠外键级联删除；session 按 website_id 关联，没有外键，手动清理
  await sql.begin(async (tx) => {
    const [row] = await tx`
      delete from project where id = ${id} returning "websiteId"`;
    if (row?.websiteId) {
      await tx`delete from session where website_id = ${row.websiteId}`;
      await tx`delete from blocked_session where website_id = ${row.websiteId}`;
    }
  });
};

/** 保存策略时使旧的超时任务失效，不覆盖人工接管标记。 */
export const saveProjectSupport = async (id: string, support: SupportConfig) => {
  return await sql.begin(async (tx) => {
    const [row] = await tx`
      update project set ${tx({ support })} where id = ${id} returning *`;
    if (!row) return null;
    if (row.websiteId) {
      await tx`
        update session set
          pending_since = null, deadline_at = null, pending_token = null,
          pending_message = null, fallback_active = false, fallback_action = null,
          control_version = control_version + 1
        where website_id = ${row.websiteId}`;
    }
    return toProject(row);
  });
};

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

/**
 * 根据 session_id 获取会话记录，未找到返回 `null`
 */
export const getSession = async (session_id: string) => {
  const [row] = await sql`
    select * from session where session_id = ${session_id} limit 1`;
  return toSession(row);
};
export const getSessionByTopic = async (group_id: number, topic_id: number) => {
  const [row] = await sql`
    select * from session
    where group_id = ${group_id} and topic_id = ${topic_id} limit 1`;
  return toSession(row);
};
/**
 * 建会话。session_id 已存在时不覆盖原有的 topic / thread，只返回现有记录
 */
export const upsertSession = async (session: Session) => {
  const [row] = await sql`
    insert into session ${sql(session)}
    on conflict (session_id) do update set website_id = excluded.website_id
    returning *`;
  return toSession(row);
};
export const updateSession = async (
  session_id: string,
  patch: Record<string, unknown>,
) => {
  const [row] = await sql`
    update session set ${sql(clean(patch))}
    where session_id = ${session_id} returning *`;
  return toSession(row);
};
/** 人工回复/策略切换改变 control_version 后，旧任务不能再写入接管状态。 */
export const updateSessionIfVersion = async (
  sessionId: string,
  version: number,
  patch: Record<string, unknown>,
) => {
  const data = clean(patch);
  if (Object.keys(data).length === 0) {
    const row = await getSession(sessionId);
    return row?.control_version === version ? row : null;
  }
  const [row] = await sql`
    update session set ${sql(data)}
    where session_id = ${sessionId} and control_version = ${version}
    returning *`;
  return toSession(row);
};
export const listPendingSessions = async (): Promise<any[]> => {
  const rows = await sql`
    select * from session where deadline_at <= now() and pending_token is not null
    order by deadline_at asc`;
  return rows.map(toSession);
};
/**
 * 切换 AI 回复开关并刷新 enable_time。
 * 只在状态确实变化时更新，避免重复点击把恢复 AI 的倒计时重置
 */
export const setSessionReply = async (session_id: string, enable: boolean) => {
  await sql`
    update session set enable_reply = ${enable}, enable_time = now()
    where session_id = ${session_id} and enable_reply = ${!enable}`;
};
export const setSessionReplyByTopic = async (
  group_id: number,
  topic_id: number,
  enable: boolean,
) => {
  await sql`
    update session set enable_reply = ${enable}, enable_time = now()
    where group_id = ${group_id} and topic_id = ${topic_id}
      and enable_reply = ${!enable}`;
};
export const listDisabledSessions = async (): Promise<any[]> => {
  const rows = await sql`select * from session where enable_reply = false`;
  return rows.map(toSession);
};
export const enableSessions = async (session_ids: string[]) => {
  if (session_ids.length === 0) return;
  await sql`
    update session set enable_reply = true, enable_time = now()
    where session_id in ${sql(session_ids)}`;
};
/** A legacy timer may only restore the exact state it observed before scanning. */
export const enableSessionIfUnchanged = async (
  sessionId: string,
  expectedEnableTime: Date,
  version: number,
): Promise<boolean> => {
  const [row] = await sql`
    update session set enable_reply = true, enable_time = now()
    where session_id = ${sessionId} and enable_reply = false
      -- JavaScript Date retains milliseconds; PostgreSQL timestamps retain microseconds.
      and date_trunc('milliseconds', enable_time) = ${expectedEnableTime}
      and control_version = ${version}
      and exists (
        select 1 from project p
        where p."websiteId" = session.website_id
          and coalesce(p.support->>'enabled', 'false') <> 'true'
      )
      and not exists (
        select 1 from blocked_session b
        where b.website_id = session.website_id and b.session_id = session.session_id
      )
    returning session_id`;
  return !!row;
};
export const deleteSessions = async (session_ids: string[]) => {
  if (session_ids.length === 0) return;
  await sql`delete from session where session_id in ${sql(session_ids)}`;
};
export const deleteSessionsBefore = async (before: Date) => {
  const rows = await sql`
    delete from session
    where pending_token is null
      and greatest(enable_time, last_customer_at, last_human_at) < ${before}
    returning session_id`;
  await sql`delete from control_event where created_at < ${before}`;
  return rows.map((row: any) => row.session_id as string);
};

const normalizeSessionId = (sessionId: string) =>
  sessionId.replace(/^session_/, "");

/** 人工消息可能早于访客入队，先建立最小会话再原子使旧接管任务失效。 */
export const markHumanActivity = async (
  websiteId: string,
  sessionId: string,
  eventKey?: string,
) => {
  return sql.begin(async (tx) => {
    if (eventKey) {
      const [inserted] = await tx`
        insert into control_event (event_key) values (${eventKey})
        on conflict (event_key) do nothing returning event_key`;
      if (!inserted) {
        const [existing] = await tx`
          select * from session
          where website_id = ${websiteId} and session_id = ${normalizeSessionId(sessionId)}`;
        return toSession(existing);
      }
    }
    const [row] = await tx`
      insert into session (website_id, session_id, enable_reply, last_human_at, control_version)
      values (${websiteId}, ${normalizeSessionId(sessionId)}, false, now(), 1)
      on conflict (session_id) do update set
        enable_reply = false, enable_time = now(), last_human_at = now(),
        pending_since = null, deadline_at = null, pending_token = null,
        pending_message = null, fallback_active = false, fallback_action = null,
        control_version = session.control_version + 1
      where session.website_id = excluded.website_id
      returning *`;
    return toSession(row);
  });
};

// ---------------------------------------------------------------------------
// blocked_session（不随会话过期清理删除）
// ---------------------------------------------------------------------------

export const listBlockedSessions = async (websiteId: string): Promise<any[]> =>
  await sql`
    select website_id, session_id, reason, source, created_at
    from blocked_session where website_id = ${websiteId}
    order by created_at desc`;

export const isSessionBlocked = async (
  websiteId: string,
  sessionId: string,
): Promise<boolean> => {
  const [row] = await sql`
    select 1 from blocked_session
    where website_id = ${websiteId} and session_id = ${normalizeSessionId(sessionId)}
    limit 1`;
  return !!row;
};

export const blockSession = async (
  websiteId: string,
  sessionId: string,
  reason = "",
  source: "manual" | "abuse" = "manual",
) => {
  const cleanId = normalizeSessionId(sessionId);
  return await sql.begin(async (tx) => {
    const [row] = await tx`
      insert into blocked_session ${tx({
        website_id: websiteId, session_id: cleanId, reason, source,
      })}
      on conflict (website_id, session_id) do update set
        reason = excluded.reason, source = excluded.source
      returning *`;
    await tx`
      update session set
        pending_since = null, deadline_at = null, pending_token = null,
        pending_message = null, fallback_active = false, fallback_action = null,
        control_version = control_version + 1
      where website_id = ${websiteId} and session_id = ${cleanId}`;
    return row;
  });
};

export const unblockSession = async (websiteId: string, sessionId: string) => {
  const cleanId = normalizeSessionId(sessionId);
  await sql.begin(async (tx) => {
    await tx`
      delete from blocked_session where website_id = ${websiteId} and session_id = ${cleanId}`;
    await tx`
      update session set
        pending_since = null, deadline_at = null, pending_token = null,
        pending_message = null, fallback_active = false, fallback_action = null,
        control_version = control_version + 1
      where website_id = ${websiteId} and session_id = ${cleanId}`;
  });
};

// ---------------------------------------------------------------------------
// option
// ---------------------------------------------------------------------------

export const getOption = async (projectId: string): Promise<any[]> => {
  return await sql`
    select * from option where project_id = ${projectId}
    order by created_at asc`;
};
export const getOptionById = async (id: string) => {
  const [row] = await sql`select * from option where id = ${id} limit 1`;
  return row ?? null;
};
export const insertOption = async (option: {
  id?: string;
  project_id: string;
  name: string;
  text: string;
  options: unknown[];
}) => {
  const [row] = await sql`
    insert into option ${sql(clean(option))} returning *`;
  return row;
};
export const updateOption = async (
  id: string,
  project_id: string,
  patch: { name: string; text: string; options: unknown[] },
) => {
  await sql`
    update option set ${sql(patch)}
    where id = ${id} and project_id = ${project_id}`;
};
export const deleteOption = async (id: string) => {
  await sql`delete from option where id = ${id}`;
};

// ---------------------------------------------------------------------------
// payload（知识库）
// ---------------------------------------------------------------------------

const toVector = (embedding: number[]) => JSON.stringify(embedding);

export const hasPayload = async (projectId: string) => {
  const [row] = await sql`
    select 1 from payload where project = ${projectId} limit 1`;
  return !!row;
};
// 列表不返回 vector，1536 维一条就有十几 KB
export const listPayloads = async (projectId: string): Promise<any[]> => {
  return await sql`
    select id, project, name, raw, created_at from payload
    where project = ${projectId} order by created_at desc`;
};
// 导出用：vector 以文本形式 "[0.1,0.2,...]" 带出
export const listPayloadsWithVector = async (projectId: string): Promise<any[]> => {
  return await sql`
    select id, name, raw, vector::text as vector, created_at from payload
    where project = ${projectId} order by created_at asc`;
};
export const getPayloadById = async (id: string) => {
  const [row] = await sql`
    select id, project, name, raw, created_at from payload
    where id = ${id} limit 1`;
  return row ?? null;
};
export const insertPayload = async (
  project: string,
  name: string,
  raw: string,
  embedding: number[] | string | null,
  id?: string,
) => {
  const vector =
    typeof embedding === "string" || embedding === null
      ? embedding
      : toVector(embedding);
  await sql`
    insert into payload (id, project, name, raw, vector)
    values (coalesce(${id ?? null}::uuid, gen_random_uuid()), ${project},
            ${name}, ${raw}, ${vector}::extensions.vector)`;
};
export const updatePayload = async (
  id: string,
  project: string,
  name: string,
  raw: string,
  embedding: number[],
) => {
  await sql`
    update payload
    set name = ${name}, raw = ${raw},
        vector = ${toVector(embedding)}::extensions.vector, created_at = now()
    where id = ${id} and project = ${project}`;
};
export const deletePayload = async (id: string) => {
  await sql`delete from payload where id = ${id}`;
};
/**
 * 知识库向量检索（余弦相似度），对应 db/schema.sql 里的 match_payloads 函数
 */
export const matchPayloads = async (
  project: string,
  embedding: number[],
  matchCount = 3,
): Promise<any[]> => {
  return await sql`
    select id, name, raw, similarity
    from match_payloads(${project}, ${toVector(embedding)}::extensions.vector,
                        ${matchCount})`;
};

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/**
 * 在一个事务里写入导入的项目、选项和知识库，任何一步失败都整体回滚
 */
export const importProject = async (data: {
  project: Record<string, unknown>;
  options: { id: string; name: string; text: string; options: unknown[] }[];
  payloads: { name: string; raw: string; vector: string | null }[];
}) => {
  return await sql.begin(async (tx) => {
    const [project] = await tx`
      insert into project ${tx(clean(data.project))} returning *`;
    for (const option of data.options) {
      await tx`
        insert into option ${tx({ ...option, project_id: project.id })}`;
    }
    for (const payload of data.payloads) {
      await tx`
        insert into payload (project, name, raw, vector)
        values (${project.id}, ${payload.name}, ${payload.raw},
                ${payload.vector}::extensions.vector)`;
    }
    return toProject(project);
  });
};

export default sql;
