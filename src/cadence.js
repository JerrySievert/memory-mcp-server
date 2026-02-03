/**
 * Cadence Module
 *
 * Manages the cadence/scheduling system for memory review.
 * Determines which memories are due for review based on their
 * cadence settings and last access time.
 *
 * Cadence Types:
 * - daily: Review every day
 * - weekly: Review once per week
 * - monthly: Review once per month
 * - day_of_week: Review on specific day (e.g., "sunday", "monday")
 * - calendar_day: Review on specific day of month (e.g., "1", "15", "last")
 *
 * @module cadence
 */

import { query, queryOne } from "./database.js";

/**
 * Days of the week mapping for day_of_week cadence.
 */
const DAYS_OF_WEEK = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Check if a memory is due for review based on its cadence.
 *
 * @param {Object} memory - Memory object with cadence_type, cadence_value, last_accessed
 * @param {Date} [referenceDate=new Date()] - Date to check against
 * @returns {boolean} True if memory is due for review
 *
 * @example
 * const isDue = isMemoryDue({
 *   cadence_type: "weekly",
 *   last_accessed: "2024-01-01T00:00:00Z"
 * });
 */
export function isMemoryDue(memory, referenceDate = new Date()) {
  const { cadence_type, cadence_value, last_accessed } = memory;

  // If never accessed, it's due
  if (!last_accessed) {
    return true;
  }

  const lastAccessDate = new Date(last_accessed);
  const now = referenceDate;

  switch (cadence_type) {
    case "daily":
      return isDailyDue(lastAccessDate, now);

    case "weekly":
      return isWeeklyDue(lastAccessDate, now);

    case "monthly":
      return isMonthlyDue(lastAccessDate, now);

    case "day_of_week":
      return isDayOfWeekDue(lastAccessDate, now, cadence_value);

    case "calendar_day":
      return isCalendarDayDue(lastAccessDate, now, cadence_value);

    default:
      // Default to monthly if unknown type
      return isMonthlyDue(lastAccessDate, now);
  }
}

/**
 * Check if a daily cadence memory is due.
 * Due if last accessed was before today.
 *
 * @param {Date} lastAccessed - Last access date
 * @param {Date} now - Current date
 * @returns {boolean} True if due
 */
function isDailyDue(lastAccessed, now) {
  const lastAccessDay = new Date(lastAccessed.getFullYear(), lastAccessed.getMonth(), lastAccessed.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return lastAccessDay < today;
}

/**
 * Check if a weekly cadence memory is due.
 * Due if last accessed was more than 7 days ago.
 *
 * @param {Date} lastAccessed - Last access date
 * @param {Date} now - Current date
 * @returns {boolean} True if due
 */
function isWeeklyDue(lastAccessed, now) {
  const daysDiff = Math.floor((now - lastAccessed) / (1000 * 60 * 60 * 24));
  return daysDiff >= 7;
}

/**
 * Check if a monthly cadence memory is due.
 * Due if last accessed was more than 30 days ago.
 *
 * @param {Date} lastAccessed - Last access date
 * @param {Date} now - Current date
 * @returns {boolean} True if due
 */
function isMonthlyDue(lastAccessed, now) {
  const daysDiff = Math.floor((now - lastAccessed) / (1000 * 60 * 60 * 24));
  return daysDiff >= 30;
}

/**
 * Check if a day_of_week cadence memory is due.
 * Due if today is the specified day and hasn't been accessed today.
 *
 * @param {Date} lastAccessed - Last access date
 * @param {Date} now - Current date
 * @param {string} dayName - Day of week (e.g., "sunday")
 * @returns {boolean} True if due
 */
function isDayOfWeekDue(lastAccessed, now, dayName) {
  const targetDay = DAYS_OF_WEEK[dayName?.toLowerCase()];

  if (targetDay === undefined) {
    return false; // Invalid day name
  }

  const currentDay = now.getDay();

  // Not the right day of week
  if (currentDay !== targetDay) {
    return false;
  }

  // Check if accessed today
  const lastAccessDay = new Date(lastAccessed.getFullYear(), lastAccessed.getMonth(), lastAccessed.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return lastAccessDay < today;
}

/**
 * Check if a calendar_day cadence memory is due.
 * Due if today is the specified day of month and hasn't been accessed today.
 *
 * @param {Date} lastAccessed - Last access date
 * @param {Date} now - Current date
 * @param {string} dayValue - Day of month (e.g., "15", "last", "1")
 * @returns {boolean} True if due
 */
function isCalendarDayDue(lastAccessed, now, dayValue) {
  const currentDayOfMonth = now.getDate();
  let targetDay;

  if (dayValue?.toLowerCase() === "last") {
    // Last day of month
    targetDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  } else {
    targetDay = parseInt(dayValue, 10);

    if (isNaN(targetDay) || targetDay < 1 || targetDay > 31) {
      return false; // Invalid day
    }

    // Handle months with fewer days
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    if (targetDay > lastDayOfMonth) {
      targetDay = lastDayOfMonth;
    }
  }

  // Not the right day of month
  if (currentDayOfMonth !== targetDay) {
    return false;
  }

  // Check if accessed today
  const lastAccessDay = new Date(lastAccessed.getFullYear(), lastAccessed.getMonth(), lastAccessed.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return lastAccessDay < today;
}

/**
 * Get all memories that are due for review.
 * Filters by cadence and returns memories sorted by importance.
 *
 * @param {Object} options - Query options
 * @param {string} [options.category] - Filter by category
 * @param {string} [options.type] - Filter by type
 * @param {number} [options.minImportance] - Minimum importance
 * @param {number} [options.limit=20] - Maximum results
 * @param {boolean} [options.includeNeverAccessed=true] - Include memories never accessed
 * @returns {Object[]} Array of due memories
 *
 * @example
 * // Get all due memories
 * const due = getDueMemories();
 *
 * @example
 * // Get high-importance due memories in "work" category
 * const due = getDueMemories({ category: "work", minImportance: 7 });
 */
export function getDueMemories(options = {}) {
  const {
    category,
    type,
    minImportance,
    limit = 20,
    includeNeverAccessed = true,
  } = options;

  // Build query conditions
  const conditions = ["archived = 0"];
  const params = [];

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  if (minImportance !== undefined) {
    conditions.push("importance >= ?");
    params.push(minImportance);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get all candidate memories
  const memories = query(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed, archived
     FROM memories ${whereClause}
     ORDER BY importance DESC`,
    params
  );

  // Filter to only due memories
  const now = new Date();
  const dueMemories = [];

  for (const memory of memories) {
    // Handle never accessed
    if (!memory.last_accessed) {
      if (includeNeverAccessed) {
        dueMemories.push({
          ...memory,
          tags: JSON.parse(memory.tags || "[]"),
          due_reason: "never_accessed",
        });
      }
      continue;
    }

    if (isMemoryDue(memory, now)) {
      dueMemories.push({
        ...memory,
        tags: JSON.parse(memory.tags || "[]"),
        due_reason: memory.cadence_type,
      });
    }

    if (dueMemories.length >= limit) {
      break;
    }
  }

  return dueMemories.slice(0, limit);
}

/**
 * Get memories due on a specific date.
 * Useful for planning or previewing what will be due.
 *
 * @param {Date} date - The date to check
 * @param {Object} [options] - Query options (same as getDueMemories)
 * @returns {Object[]} Array of memories that would be due on that date
 *
 * @example
 * // What's due next Sunday?
 * const nextSunday = new Date('2024-01-07');
 * const due = getMemoriesDueOn(nextSunday);
 */
export function getMemoriesDueOn(date, options = {}) {
  const { category, type, minImportance, limit = 20 } = options;

  const conditions = ["archived = 0"];
  const params = [];

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  if (minImportance !== undefined) {
    conditions.push("importance >= ?");
    params.push(minImportance);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const memories = query(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed, archived
     FROM memories ${whereClause}
     ORDER BY importance DESC`,
    params
  );

  const dueMemories = [];
  const targetDate = new Date(date);

  for (const memory of memories) {
    if (isMemoryDue(memory, targetDate)) {
      dueMemories.push({
        ...memory,
        tags: JSON.parse(memory.tags || "[]"),
      });
    }

    if (dueMemories.length >= limit) {
      break;
    }
  }

  return dueMemories;
}

/**
 * Calculate the next review date for a memory based on its cadence.
 *
 * @param {Object} memory - Memory with cadence settings
 * @returns {Date|null} Next review date or null if cannot be determined
 *
 * @example
 * const nextDate = getNextReviewDate({
 *   cadence_type: "weekly",
 *   last_accessed: "2024-01-01T00:00:00Z"
 * });
 */
export function getNextReviewDate(memory) {
  const { cadence_type, cadence_value, last_accessed } = memory;

  const baseDate = last_accessed ? new Date(last_accessed) : new Date();

  switch (cadence_type) {
    case "daily": {
      const next = new Date(baseDate);
      next.setDate(next.getDate() + 1);
      return next;
    }

    case "weekly": {
      const next = new Date(baseDate);
      next.setDate(next.getDate() + 7);
      return next;
    }

    case "monthly": {
      const next = new Date(baseDate);
      next.setMonth(next.getMonth() + 1);
      return next;
    }

    case "day_of_week": {
      const targetDay = DAYS_OF_WEEK[cadence_value?.toLowerCase()];
      if (targetDay === undefined) return null;

      const next = new Date(baseDate);
      const currentDay = next.getDay();
      let daysToAdd = targetDay - currentDay;

      if (daysToAdd <= 0) {
        daysToAdd += 7;
      }

      next.setDate(next.getDate() + daysToAdd);
      return next;
    }

    case "calendar_day": {
      const next = new Date(baseDate);
      let targetDay;

      if (cadence_value?.toLowerCase() === "last") {
        // Move to next month, then get last day
        next.setMonth(next.getMonth() + 1);
        targetDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      } else {
        targetDay = parseInt(cadence_value, 10);
        if (isNaN(targetDay)) return null;

        // If we're past this day in current month, move to next month
        if (next.getDate() >= targetDay) {
          next.setMonth(next.getMonth() + 1);
        }
      }

      // Handle months with fewer days
      const lastDayOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(targetDay, lastDayOfMonth));

      return next;
    }

    default:
      return null;
  }
}

/**
 * Get a summary of upcoming reviews grouped by date.
 *
 * @param {number} [days=7] - Number of days to look ahead
 * @returns {Object} Object with dates as keys and arrays of memories as values
 *
 * @example
 * const schedule = getReviewSchedule(7);
 * // { "2024-01-01": [...], "2024-01-02": [...] }
 */
export function getReviewSchedule(days = 7) {
  const memories = query(
    `SELECT id, category, type, content, tags, importance, cadence_type, cadence_value,
            context, created_at, updated_at, last_accessed
     FROM memories WHERE archived = 0`
  );

  const schedule = {};
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(checkDate.getDate() + i);
    const dateKey = checkDate.toISOString().split("T")[0];
    schedule[dateKey] = [];

    for (const memory of memories) {
      if (isMemoryDue(memory, checkDate)) {
        schedule[dateKey].push({
          id: memory.id,
          category: memory.category,
          type: memory.type,
          content: memory.content.substring(0, 100) + (memory.content.length > 100 ? "..." : ""),
          importance: memory.importance,
          cadence_type: memory.cadence_type,
        });
      }
    }
  }

  return schedule;
}

export default {
  isMemoryDue,
  getDueMemories,
  getMemoriesDueOn,
  getNextReviewDate,
  getReviewSchedule,
};
