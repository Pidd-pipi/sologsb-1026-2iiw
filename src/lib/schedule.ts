export interface SchedulableActivity {
  id: string;
  title: string;
  type: string;
  duration: number;
  dependencies: string[];
}

export interface ScheduleLessonItem {
  id: string;
  title: string;
  type: string;
  duration: number;
  dependencies: string[];
}

export interface ScheduleLesson {
  items: ScheduleLessonItem[];
  totalMinutes: number;
}

export interface SchedulePending {
  id: string;
  title: string;
  type: string;
  duration: number;
  reason: 'waiting' | 'unplaced';
  blockedBy: string[];
}

export interface SchedulePlan {
  lessonMinutes: number;
  generatedAt: string;
  lessons: ScheduleLesson[];
  pending: SchedulePending[];
  signature: string;
}

export interface ScheduleDiffRow {
  id: string;
  title: string;
  kind: 'schedule';
  detail: string;
}

interface ScheduleVersionLike {
  schedule: SchedulePlan | null;
  activities: Array<{ id: string; title: string }>;
}

/** 返回构成循环的活动 id 链（首尾相同）；无循环时返回 null。 */
export function findDependencyCycle(activities: SchedulableActivity[]): string[] | null {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: string[] = [];
  const visit = (id: string, path: string[]): boolean => {
    if (visiting.has(id)) {
      cycle = [...path.slice(path.indexOf(id)), id];
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    const activity = byId.get(id);
    for (const dependency of activity?.dependencies ?? []) {
      if (visit(dependency, [...path, dependency])) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const activity of activities) {
    if (visit(activity.id, [activity.id])) break;
  }
  return cycle.length ? cycle : null;
}

/** 影响排课结果的内容指纹：顺序、id、时长、依赖；标题等非排课字段不参与。 */
export function scheduleSignature(activities: SchedulableActivity[]): string {
  return activities
    .map((activity) => `${activity.id}:${activity.duration}:${[...activity.dependencies].sort().join('+')}`)
    .join('|');
}

/**
 * 按当前顺序单趟扫描生成连续课次：
 * - 单个活动超过每节课分钟数：标记为未排入，进入待处理区；
 * - 前置活动尚未排入（含超上限、被前置阻塞或已失效的引用）：本活动留在待处理区；
 * - 当前节放不下时开启新的一节；同一节内允许先排入的活动作为后续活动的前置。
 */
export function buildSchedule(activities: SchedulableActivity[], lessonMinutes: number): SchedulePlan {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const lessons: ScheduleLesson[] = [];
  const pending: SchedulePending[] = [];
  const scheduled = new Set<string>();
  let current: ScheduleLesson = { items: [], totalMinutes: 0 };

  activities.forEach((activity) => {
    if (activity.duration > lessonMinutes) {
      pending.push({
        id: activity.id, title: activity.title, type: activity.type, duration: activity.duration,
        reason: 'unplaced', blockedBy: []
      });
      return;
    }
    const missing = activity.dependencies.filter((dependency) => !scheduled.has(dependency));
    if (missing.length) {
      pending.push({
        id: activity.id, title: activity.title, type: activity.type, duration: activity.duration,
        reason: 'waiting',
        blockedBy: missing.map((dependency) => byId.get(dependency)?.title ?? dependency)
      });
      return;
    }
    if (current.items.length && current.totalMinutes + activity.duration > lessonMinutes) {
      lessons.push(current);
      current = { items: [], totalMinutes: 0 };
    }
    current.items.push({
      id: activity.id, title: activity.title, type: activity.type, duration: activity.duration,
      dependencies: [...activity.dependencies]
    });
    current.totalMinutes += activity.duration;
    scheduled.add(activity.id);
  });

  if (current.items.length) lessons.push(current);
  return {
    lessonMinutes,
    generatedAt: new Date().toISOString(),
    lessons,
    pending,
    signature: scheduleSignature(activities)
  };
}

/** 活动 id → 所在课次（1 起）；待处理区记为 0。 */
export function placementMap(plan: SchedulePlan): Map<string, number> {
  const map = new Map<string, number>();
  plan.lessons.forEach((lesson, index) => {
    lesson.items.forEach((item) => map.set(item.id, index + 1));
  });
  plan.pending.forEach((item) => map.set(item.id, 0));
  return map;
}

/** 比较两个版本快照中的授课安排：分钟数、课次数以及每个活动的课次归属变化。 */
export function diffSchedules(base: ScheduleVersionLike, target: ScheduleVersionLike): ScheduleDiffRow[] {
  const rows: ScheduleDiffRow[] = [];
  const before = base.schedule ?? null;
  const after = target.schedule ?? null;
  if (!before && !after) return rows;
  if (!before || !after) {
    rows.push({
      id: 'schedule-state', title: '授课安排', kind: 'schedule',
      detail: after
        ? `目标版本新增授课安排：每节 ${after.lessonMinutes} 分钟，共 ${after.lessons.length} 节课${after.pending.length ? `，${after.pending.length} 个活动在待处理区` : ''}`
        : '目标版本没有保存授课安排'
    });
    return rows;
  }
  if (before.lessonMinutes !== after.lessonMinutes) {
    rows.push({ id: 'schedule-minutes', title: '授课安排', kind: 'schedule', detail: `每节课分钟数 ${before.lessonMinutes} → ${after.lessonMinutes} 分钟` });
  }
  if (before.lessons.length !== after.lessons.length) {
    rows.push({ id: 'schedule-count', title: '授课安排', kind: 'schedule', detail: `课次数量 ${before.lessons.length} → ${after.lessons.length} 节` });
  }
  const beforeMap = placementMap(before);
  const afterMap = placementMap(after);
  const labelOf = (value: number | undefined) => (value ? `第 ${value} 节` : '待处理区');
  [...new Set([...beforeMap.keys(), ...afterMap.keys()])].forEach((id) => {
    const from = beforeMap.get(id) ?? 0;
    const to = afterMap.get(id) ?? 0;
    if (from === to) return;
    const title = target.activities.find((activity) => activity.id === id)?.title
      ?? base.activities.find((activity) => activity.id === id)?.title ?? id;
    rows.push({ id: `schedule-${id}`, title, kind: 'schedule', detail: `课次变化：${labelOf(from)} → ${labelOf(to)}` });
  });
  return rows;
}
