# Daily Runner Agent Instructions

These instructions guide an autonomous agent that runs on a daily schedule to review time-sensitive memories, check due items, and take autonomous actions on behalf of the user.

## Overview

The Daily Runner is a scheduled agent that executes once per day (typically early morning) to:
- Review all memories due for the day based on cadence settings
- Identify time-sensitive tasks requiring immediate action
- Take autonomous actions (email, calendar, web search) within configured trust levels
- Generate a daily briefing for the user
- Update memory state based on reviews and actions

---

## 1. Configuration

### 1.1 Load User Configuration

Read configuration from `~/.mcp/memory.json`:

```json
{
  "store_id": "user-fork-uuid",
  "user_id": "username",
  "timezone": "America/New_York",
  "trust_levels": {
    "email": "sandbox",
    "calendar": "sandbox",
    "web_search": "autonomous",
    "notifications": "autonomous"
  },
  "daily_run_time": "06:00",
  "briefing_delivery": "memory"
}
```

### 1.2 Trust Levels

Each action type has a configurable trust level:

| Level | Behavior |
|-------|----------|
| `autonomous` | Execute without user approval |
| `sandbox` | Execute in sandbox/draft mode, queue for user review |
| `notify_only` | Don't execute, just notify user action is needed |
| `disabled` | Skip entirely |

### 1.3 Store Context

- Use the `store_id` from configuration for all memory operations
- This ensures user isolation - each user's fork is independent
- If no store_id configured, use "main" (but log a warning)

---

## 2. Startup Sequence

### 2.1 Initialize
```
1. Read ~/.mcp/memory.json
2. Get current date and time
3. Log: "Daily Runner starting for user [user_id] at [timestamp]"
4. Connect to memory store with configured store_id
```

### 2.2 Get Current State
```
1. Call get_due_memories() to get all items due today
2. Search for memories containing today's date in content/tags
3. Search for memories with cadence matching today:
   - daily: Always included
   - weekly: If today matches configured day
   - monthly: If today matches configured date
   - day_of_week: If today is that day (e.g., "monday")
   - calendar_day: If today is that date (e.g., "15" or "last")
4. Search for upcoming items (next 24-48 hours)
```

---

## 3. Triage and Priority

### 3.1 Categorize Items

All due items are treated as ASAP priority. Categorize by type:

**Actionable Items** - Require autonomous action:
- Tasks with action markers: `[EMAIL]`, `[CALENDAR]`, `[WEB_SEARCH]`
- Follow-ups with specific instructions
- Scheduled sends or posts

**Review Items** - Need user attention:
- Goals for progress check
- Projects for status update
- Relationships for follow-up consideration
- Decisions pending input

**Informational Items** - Surface in briefing:
- Anniversaries, birthdays
- Recurring reminders
- Context refreshers

### 3.2 Action Markers

Look for these markers in memory content to identify required actions:

| Marker | Action | Example |
|--------|--------|---------|
| `[EMAIL]` | Send email | `[EMAIL] Send weekly update to team` |
| `[EMAIL:draft]` | Draft email for review | `[EMAIL:draft] Follow up with client` |
| `[CALENDAR]` | Check/create calendar event | `[CALENDAR] Schedule review meeting` |
| `[CALENDAR:check]` | Verify calendar entry exists | `[CALENDAR:check] Confirm dentist appointment` |
| `[WEB_SEARCH]` | Research topic | `[WEB_SEARCH] Check stock price of ACME` |
| `[NOTIFY]` | Send notification to user | `[NOTIFY] Reminder: Mom's birthday tomorrow` |
| `[TASK]` | Generic task marker | `[TASK] Review pull request` |

### 3.3 Extract Action Details

For each actionable item, parse:
- Action type (from marker)
- Recipients (for email)
- Subject/topic
- Body/content
- Deadline (if specified)
- Related memories (for context)

---

## 4. Action Execution

### 4.1 Pre-Action Checklist

Before executing any action:
1. Check trust level for action type
2. If `disabled`, skip and log
3. If `notify_only`, add to notification queue
4. If `sandbox`, execute in draft/sandbox mode
5. If `autonomous`, proceed with execution

### 4.2 Email Actions `[EMAIL]`

**When trust_level is "autonomous":**
```
1. Parse recipient, subject, body from memory content
2. Search for related context in memory
3. [EMAIL] Compose and send email
4. Create memory logging the action taken
5. Update original memory with "Sent on [date]"
```

**When trust_level is "sandbox":**
```
1. Parse recipient, subject, body from memory content
2. Search for related context in memory
3. [EMAIL] Create draft email (do not send)
4. Create memory with draft details for user review
5. Add to briefing: "Draft email prepared for [recipient]"
```

### 4.3 Calendar Actions `[CALENDAR]`

**When trust_level is "autonomous":**
```
1. Parse event details from memory content
2. [CALENDAR] Check for existing event
3. [CALENDAR] Create/update event if needed
4. Create memory logging the action
5. Update original memory with confirmation
```

**When trust_level is "sandbox":**
```
1. Parse event details from memory content
2. [CALENDAR] Check for existing event
3. Create memory with proposed calendar action
4. Add to briefing: "Calendar action pending: [details]"
```

### 4.4 Web Search Actions `[WEB_SEARCH]`

**When trust_level is "autonomous":**
```
1. Parse search query from memory content
2. [WEB_SEARCH] Execute search
3. Create memory with search results summary
4. Link results to original memory
5. Add to briefing: "Researched: [topic]"
```

### 4.5 Notification Actions `[NOTIFY]`

**When trust_level is "autonomous":**
```
1. Parse notification content
2. [NOTIFY] Send notification to user
3. Log notification sent
```

---

## 5. Daily Briefing Generation

### 5.1 Briefing Structure

Create a comprehensive daily briefing:

```markdown
# Daily Briefing - [Date]

## Urgent Items
- [List items requiring immediate attention]

## Actions Taken
- [List autonomous actions executed]
- [List items queued for review]

## Due for Review
- [Goals to check progress]
- [Projects to update]
- [Relationships to consider]

## Today's Schedule
- [Calendar events from memory]
- [Deadlines approaching]

## This Week
- [Upcoming items next 7 days]
- [Weekly goals progress]

## Notes
- [Insights from memory patterns]
- [Suggestions based on goals]
```

### 5.2 Save Briefing

Based on configuration, deliver the briefing:

**If briefing_delivery is "memory":**
```
Create memory:
  category: "daily"
  type: "briefing"
  content: [Full briefing content]
  tags: ["YYYY-MM-DD", "briefing"]
  importance: 7
  cadence_type: "daily"
```

**If briefing_delivery is "email":**
```
[EMAIL] Send briefing to user's email
Also save to memory for reference
```

**If briefing_delivery is "both":**
```
Do both of the above
```

---

## 6. Memory Updates

### 6.1 Mark Items Reviewed

For each due item processed:
```
1. Access the memory (updates last_accessed timestamp)
2. This automatically advances the cadence clock
```

### 6.2 Create Action Log

For each action taken:
```
Create memory:
  category: "daily"
  type: "action_log"
  content: "Action: [type] - [description] - Status: [result]"
  tags: ["YYYY-MM-DD", "action"]
  importance: 5
  context: "Automated action by Daily Runner"
```

### 6.3 Update Task Status

For completed tasks:
```
1. Update memory content to reflect completion
2. Change tags from ["active"] to ["completed"]
3. Add context: "Completed on [date]"
```

### 6.4 Link Daily Entry

Create daily log entry:
```
Create memory:
  category: "daily"
  type: "log"
  content: [Summary of day's automated activities]
  tags: ["YYYY-MM-DD"]
  importance: 5
  cadence_type: "daily"
```

Add relationships to:
- All memories processed
- Actions taken
- Briefing generated

---

## 7. Cadence Rules Reference

### 7.1 Daily
- Due every day
- Common for: task lists, habit tracking, journals

### 7.2 Weekly
- Due once per week on configured day
- Default: Sunday
- Common for: weekly reviews, recurring meetings

### 7.3 Monthly
- Due once per month on configured date
- Default: 1st of month
- Common for: monthly goals, bill reminders

### 7.4 day_of_week
- Due on specific day of week
- cadence_value: "monday", "tuesday", etc.
- Common for: recurring meetings, specific routines

### 7.5 calendar_day
- Due on specific day of month
- cadence_value: "1", "15", "last", etc.
- Common for: paydays, monthly events

---

## 8. Error Handling

> **Note**: Comprehensive error handling and recovery is a future enhancement. For now, use basic error logging.

### 8.1 Action Failures

When an action fails:
```
1. Log error with details
2. Create memory noting the failure:
   category: "daily"
   type: "error"
   content: "Action failed: [type] - [error message]"
   tags: ["YYYY-MM-DD", "error"]
   importance: 8
3. Add to briefing under "Errors" section
4. Continue with remaining items
```

### 8.2 Connection Failures

If memory store connection fails:
```
1. Log critical error
2. Retry up to 3 times with exponential backoff
3. If still failing, send notification (if possible)
4. Exit with error code
```

### 8.3 Future Enhancements Needed

- [ ] Create snapshot before daily run for recovery
- [ ] Implement partial progress logging
- [ ] Add retry logic for transient failures
- [ ] Queue failed actions for next run
- [ ] Alerting for repeated failures

---

## 9. Execution Flow Summary

```
START
  |
  v
[Load ~/.mcp/memory.json]
  |
  v
[Connect to store with store_id]
  |
  v
[Get due memories]
  |
  v
[Categorize: Actionable / Review / Informational]
  |
  v
[For each actionable item:]
  |---> Check trust level
  |---> Execute or queue based on level
  |---> Log action taken
  |
  v
[Generate daily briefing]
  |
  v
[Save briefing to memory]
  |
  v
[Update all processed memories]
  |
  v
[Create daily log entry]
  |
  v
END
```

---

## 10. Example Configuration

### ~/.mcp/memory.json

```json
{
  "store_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "user_id": "jerry",
  "timezone": "America/Los_Angeles",
  "trust_levels": {
    "email": "sandbox",
    "calendar": "sandbox",
    "web_search": "autonomous",
    "notifications": "autonomous"
  },
  "daily_run_time": "06:00",
  "briefing_delivery": "memory",
  "weekly_review_day": "sunday",
  "monthly_review_day": "1"
}
```

---

## 11. Sample Memories with Action Markers

### Email Task
```
category: "tasks"
type: "task"
content: "[EMAIL] Send weekly status update to team@company.com with project progress summary"
tags: ["work", "recurring", "weekly"]
importance: 7
cadence_type: "weekly"
cadence_value: "friday"
```

### Calendar Check
```
category: "tasks"
type: "task"
content: "[CALENDAR:check] Verify dentist appointment is on calendar for next Tuesday at 2pm"
tags: ["health", "appointment"]
importance: 6
cadence_type: "monthly"
```

### Research Task
```
category: "tasks"
type: "task"
content: "[WEB_SEARCH] Check current price of AAPL stock and compare to last week"
tags: ["finance", "daily"]
importance: 5
cadence_type: "daily"
```

### Reminder Notification
```
category: "reminders"
type: "reminder"
content: "[NOTIFY] Mom's birthday is tomorrow - call her!"
tags: ["family", "birthday"]
importance: 9
cadence_type: "calendar_day"
cadence_value: "14"  // Day before birthday on the 15th
```

---

## 12. Integration Points

### Future Tool Integrations

These markers are placeholders for future tool integration:

| Marker | Future Tool | Status |
|--------|-------------|--------|
| `[EMAIL]` | Email sending service | Pending |
| `[CALENDAR]` | Calendar API (Google, Outlook) | Pending |
| `[WEB_SEARCH]` | Web search tool | Pending |
| `[NOTIFY]` | Push notification service | Pending |
| `[SMS]` | SMS sending service | Pending |
| `[SLACK]` | Slack messaging | Pending |

### Scheduler Integration

The Daily Runner should be triggered by:
- Cron job: `0 6 * * * /path/to/daily-runner.js`
- System scheduler (launchd on macOS, systemd on Linux)
- Cloud scheduler (AWS EventBridge, Cloud Scheduler)

---

## Quick Reference

### Trust Levels
| Level | Behavior |
|-------|----------|
| `autonomous` | Execute without approval |
| `sandbox` | Execute as draft, queue for review |
| `notify_only` | Just notify user |
| `disabled` | Skip entirely |

### Action Markers
| Marker | Purpose |
|--------|---------|
| `[EMAIL]` | Send email |
| `[EMAIL:draft]` | Create draft email |
| `[CALENDAR]` | Create calendar event |
| `[CALENDAR:check]` | Verify calendar event |
| `[WEB_SEARCH]` | Research topic |
| `[NOTIFY]` | Send user notification |
| `[TASK]` | Generic task |

### Cadence Types
| Type | When Due |
|------|----------|
| `daily` | Every day |
| `weekly` | Once per week |
| `monthly` | Once per month |
| `day_of_week` | Specific day (monday, tuesday...) |
| `calendar_day` | Specific date (1, 15, last...) |
