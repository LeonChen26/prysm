/**
 * 5 字段 cron 表达式解析与下次触发时间计算（纯函数，零依赖）。
 * 字段顺序：分 时 日 月 周；支持星号、数字、步进（星号斜杠 n）、范围 a-b、列表 a,b。
 * - 分 0-59、时 0-23、日 1-31、月 1-12、周 0-7（0 与 7 均表示周日，内部归一化为 0-6）
 * - 日与周字段：按 cron 惯例两者都限定（非星号）时取并集（任一匹配即触发）
 */

export interface CronField {
  min: number;
  max: number;
  values: Set<number>;
  /** 原始字段是否为 *（用于日/周并集判断） */
  wildcard: boolean;
}

export interface CronParts {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  dow: CronField;
}

const RANGES: Record<keyof Omit<CronParts, never>, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  dow: [0, 7],
};

function parseField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();
  let wildcard = false;
  for (const part of field.split(",")) {
    if (!part) throw new Error(`cron 字段含空片段`);
    if (part === "*") {
      wildcard = true;
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    let step = 1;
    let base = part;
    if (part.includes("/")) {
      const idx = part.indexOf("/");
      base = part.slice(0, idx);
      step = parseInt(part.slice(idx + 1), 10);
      if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步进非法：${part}`);
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (base.includes("-")) {
      const idx = base.indexOf("-");
      lo = parseInt(base.slice(0, idx), 10);
      hi = parseInt(base.slice(idx + 1), 10);
      if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error(`cron 范围非法：${base}`);
    } else {
      lo = parseInt(base, 10);
      hi = lo;
      if (Number.isNaN(lo)) throw new Error(`cron 值非法：${base}`);
    }
    if (lo < min || hi > max) {
      throw new Error(`cron 值越界：${lo}-${hi}（允许 ${min}-${max}）`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { min, max, values, wildcard };
}

/** 周字段归一化：7 → 0（周日） */
function normalizeDow(field: CronField): CronField {
  if (!field.values.has(7)) return field;
  const values = new Set<number>();
  for (const v of field.values) values.add(v === 7 ? 0 : v);
  return { ...field, values };
}

/** 解析 5 字段 cron 表达式；非法则抛错 */
export function parseCron(expr: string): CronParts {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 表达式须为 5 字段（分 时 日 月 周），实际 ${fields.length} 字段：${expr}`);
  }
  return {
    minute: parseField(fields[0], ...RANGES.minute),
    hour: parseField(fields[1], ...RANGES.hour),
    day: parseField(fields[2], ...RANGES.day),
    month: parseField(fields[3], ...RANGES.month),
    dow: normalizeDow(parseField(fields[4], ...RANGES.dow)),
  };
}

/** 日/周字段匹配（cron 惯例：两者都限定取并集） */
function dayMatches(parts: CronParts, d: Date): boolean {
  const dom = parts.day.values.has(d.getDate());
  const dow = parts.dow.values.has(d.getDay()); // getDay()：0=周日
  const domRestricted = !parts.day.wildcard;
  const dowRestricted = !parts.dow.wildcard;
  if (domRestricted && dowRestricted) return dom || dow;
  if (domRestricted) return dom;
  if (dowRestricted) return dow;
  return true;
}

function tryMatch(parts: CronParts, d: Date): boolean {
  if (!parts.month.values.has(d.getMonth() + 1)) return false;
  if (!dayMatches(parts, d)) return false;
  if (!parts.hour.values.has(d.getHours())) return false;
  if (!parts.minute.values.has(d.getMinutes())) return false;
  return true;
}

/** 从 from（ms epoch 或 Date）之后的第一个匹配时间（ms epoch）。5 年内无匹配抛错。 */
export function nextCronRun(expr: string, from: Date | number): number {
  const parts = parseCron(expr);
  const start = from instanceof Date ? from.getTime() : from;
  const d = new Date(start);
  d.setMilliseconds(0);
  d.setSeconds(0);
  d.setMinutes(d.getMinutes() + 1); // 严格大于 from
  // 上限：5 年（防永不匹配的死循环，如 2/29）
  const maxIter = 366 * 24 * 60 * 5;
  for (let i = 0; i < maxIter; i++) {
    if (tryMatch(parts, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`cron 表达式在 5 年内无匹配时间：${expr}`);
}
