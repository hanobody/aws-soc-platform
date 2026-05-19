package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultDatabaseURL = "postgresql://soc_admin:soc_dev_password@localhost:5433/soc_platform"

type Event struct {
	ID           int64
	EventID      string
	AccountID    string
	RegionCode   string
	EventSource  string
	EventName    string
	EventTime    time.Time
	ResourceType string
	ResourceID   string
	ResourceName string
	UserArn      string
	SourceIP     string
	RawEventJSON []byte
}

type Rule struct {
	ID                  int64
	RuleName            string
	AccountID           string
	RegionCode          string
	EventSource         string
	EventName           string
	ResourceType        string
	ResourcePattern     string
	UserArnPattern      string
	SourceIPPattern     string
	Severity            string
	CooldownSeconds     int
	NotificationRouteID *int64
	compiledResource    []*regexp.Regexp
	compiledUserArn     []*regexp.Regexp
	compiledSourceIP    []*regexp.Regexp
}

type RuleCache struct {
	mu          sync.RWMutex
	loadedAt    time.Time
	ttl         time.Duration
	version     int64
	byLookupKey map[string][]Rule
}

type NotificationChannel struct {
	ID          int64
	ChannelName string
	ChannelType string
	BotToken    string
	ChatID      string
}

type Matcher struct {
	db              *pgxpool.Pool
	batchSize       int
	pollInterval    time.Duration
	maxAttempts     int
	ruleCache       *RuleCache
	defaultSeverity string
	workerName      string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databaseURL := envOrDefault("DATABASE_URL", defaultDatabaseURL)
	batchSize := envInt("MATCHER_BATCH_SIZE", 100)
	pollInterval := time.Duration(envInt("MATCHER_POLL_INTERVAL_MS", 3000)) * time.Millisecond
	ruleCacheTTL := time.Duration(envInt("MATCHER_RULE_CACHE_TTL_SECONDS", 15)) * time.Second
	maxAttempts := envInt("MATCHER_MAX_ATTEMPTS", 10)
	defaultSeverity := envOrDefault("MATCHER_DEFAULT_SEVERITY", "medium")

	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	matcher := &Matcher{
		db:              db,
		batchSize:       batchSize,
		pollInterval:    pollInterval,
		maxAttempts:     maxAttempts,
		ruleCache:       &RuleCache{ttl: ruleCacheTTL},
		defaultSeverity: defaultSeverity,
		workerName:      envOrDefault("WORKER_NAME", "matcher-worker"),
	}

	if err := matcher.ensureWorkerStatusTable(ctx); err != nil {
		log.Fatalf("ensure worker status table: %v", err)
	}
	if err := matcher.ensureRuleConfigStateTable(ctx); err != nil {
		log.Fatalf("ensure rule config state table: %v", err)
	}
	go matcher.heartbeatLoop(ctx)
	_ = matcher.updateWorkerStatus(context.Background(), "starting", fmt.Sprintf("batch=%d poll=%s", batchSize, pollInterval))
	defer func() {
		_ = matcher.updateWorkerStatus(context.Background(), "stopped", "matcher stopped")
	}()

	log.Printf("matcher worker started batch=%d poll=%s ruleCacheTTL=%s", batchSize, pollInterval, ruleCacheTTL)
	if err := matcher.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("matcher stopped with error: %v", err)
	}
	log.Printf("matcher worker stopped")
}

func (m *Matcher) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		_ = m.updateWorkerStatus(ctx, "running", "polling ingested_events")

		if err := m.ruleCache.RefreshIfNeeded(ctx, m.db); err != nil {
			return fmt.Errorf("refresh rules: %w", err)
		}

		events, err := m.claimEvents(ctx)
		if err != nil {
			return fmt.Errorf("claim events: %w", err)
		}

		if len(events) == 0 {
			_ = m.updateWorkerStatus(ctx, "idle", "no pending events")
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(m.pollInterval):
			}
			continue
		}
		log.Printf("claimed events=%d", len(events))
		_ = m.updateWorkerStatus(ctx, "running", fmt.Sprintf("claimed events=%d", len(events)))

		for _, event := range events {
			if err := m.processEvent(ctx, event); err != nil {
				log.Printf("match failed ingested_id=%d event_id=%s err=%v", event.ID, event.EventID, err)
				if markErr := m.failEvent(ctx, event.ID, err.Error()); markErr != nil {
					log.Printf("mark failed event errored ingested_id=%d err=%v", event.ID, markErr)
				}
			}
		}
	}
}

func (m *Matcher) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = m.updateWorkerStatus(context.Background(), "running", "heartbeat")
		}
	}
}

func (m *Matcher) ensureWorkerStatusTable(ctx context.Context) error {
	const q = `
CREATE TABLE IF NOT EXISTS worker_status (
  worker_name VARCHAR(80) PRIMARY KEY,
  worker_type VARCHAR(80) NOT NULL,
  status VARCHAR(32) NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`
	_, err := m.db.Exec(ctx, q)
	return err
}

func (m *Matcher) ensureRuleConfigStateTable(ctx context.Context) error {
	const q = `
CREATE TABLE IF NOT EXISTS rule_config_state (
  scope VARCHAR(80) PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO rule_config_state (scope, version)
VALUES ('alert_rules', 1)
ON CONFLICT (scope) DO NOTHING`
	_, err := m.db.Exec(ctx, q)
	return err
}

func (m *Matcher) updateWorkerStatus(ctx context.Context, status, message string) error {
	const q = `
INSERT INTO worker_status (worker_name, worker_type, status, last_heartbeat_at, last_message, updated_at)
VALUES ($1, 'matcher-worker', $2, NOW(), $3, NOW())
ON CONFLICT (worker_name) DO UPDATE
SET status = EXCLUDED.status,
    last_heartbeat_at = EXCLUDED.last_heartbeat_at,
    last_message = EXCLUDED.last_message,
    updated_at = EXCLUDED.updated_at`
	_, err := m.db.Exec(ctx, q, m.workerName, status, nullIfEmpty(message))
	return err
}

func (m *Matcher) claimEvents(ctx context.Context) ([]Event, error) {
	const q = `
WITH picked AS (
  SELECT id
  FROM ingested_events
  WHERE process_status IN ('new', 'failed')
    AND process_attempts < $1
  ORDER BY event_time ASC, id ASC
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE ingested_events ie
SET process_status = 'processing',
    process_attempts = ie.process_attempts + 1,
    process_error = NULL
FROM picked
WHERE ie.id = picked.id
RETURNING
  ie.id,
  ie.event_id,
  ie.aws_account_id,
  ie.aws_region,
  ie.event_source,
  ie.event_name,
  ie.event_time,
  ie.resource_type,
  ie.resource_id,
  ie.resource_name,
  ie.actor_arn,
  ie.source_ip,
  ie.raw_event_json
`
	rows, err := m.db.Query(ctx, q, m.maxAttempts, m.batchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := make([]Event, 0)
	for rows.Next() {
		var e Event
		var regionCode sql.NullString
		var resourceType sql.NullString
		var resourceID sql.NullString
		var resourceName sql.NullString
		var userArn sql.NullString
		var sourceIP sql.NullString
		if err := rows.Scan(
			&e.ID,
			&e.EventID,
			&e.AccountID,
			&regionCode,
			&e.EventSource,
			&e.EventName,
			&e.EventTime,
			&resourceType,
			&resourceID,
			&resourceName,
			&userArn,
			&sourceIP,
			&e.RawEventJSON,
		); err != nil {
			return nil, err
		}
		e.RegionCode = regionCode.String
		e.ResourceType = resourceType.String
		e.ResourceID = resourceID.String
		e.ResourceName = resourceName.String
		e.UserArn = userArn.String
		e.SourceIP = sourceIP.String
		events = append(events, e)
	}
	return events, rows.Err()
}

func (m *Matcher) processEvent(ctx context.Context, event Event) error {
	candidates := m.ruleCache.Lookup(event)
	if len(candidates) == 0 {
		log.Printf("no candidate rules ingested_id=%d event_id=%s event=%s", event.ID, event.EventID, event.EventName)
		return m.finishEvent(ctx, event.ID, "processed", "no_rule_matched")
	}

	matched := make([]Rule, 0, len(candidates))
	for _, rule := range candidates {
		if ruleMatches(rule, event) {
			matched = append(matched, rule)
		}
	}
	if len(matched) == 0 {
		log.Printf("no matched rule ingested_id=%d event_id=%s event=%s", event.ID, event.EventID, event.EventName)
		return m.finishEvent(ctx, event.ID, "processed", "no_rule_matched")
	}

	sort.Slice(matched, func(i, j int) bool {
		left := ruleSpecificity(matched[i])
		right := ruleSpecificity(matched[j])
		if left != right {
			return left > right
		}
		return matched[i].ID < matched[j].ID
	})

	rule := matched[0]
	if rule.CooldownSeconds > 0 {
		cooldownHit, err := m.isCooldownHit(ctx, event, rule)
		if err != nil {
			return err
		}
		if cooldownHit {
			log.Printf("cooldown skipped ingested_id=%d rule_id=%d event=%s", event.ID, rule.ID, event.EventID)
			return m.finishEvent(ctx, event.ID, "processed", "cooldown_skipped")
		}
	}

	alertEventID, channel, err := m.insertAlertEvent(ctx, event, rule)
	if err != nil {
		return err
	}
	if channel == nil {
		if err := m.updateAlertNotificationStatus(ctx, alertEventID, nil, "pending", nil, "no_notification_channel"); err != nil {
			return err
		}
		log.Printf("matched without channel ingested_id=%d event_id=%s rule_id=%d", event.ID, event.EventID, rule.ID)
		return m.finishEvent(ctx, event.ID, "processed", nil)
	}

	if err := sendNotification(*channel, event, rule); err != nil {
		if updateErr := m.updateAlertNotificationStatus(ctx, alertEventID, &channel.ID, "notify_failed", nil, err.Error()); updateErr != nil {
			return fmt.Errorf("notify failed: %v; update status failed: %w", err, updateErr)
		}
		return fmt.Errorf("notify alert event: %w", err)
	}

	if err := m.updateAlertNotificationStatus(ctx, alertEventID, &channel.ID, "sent", timePtr(time.Now().UTC()), nil); err != nil {
		return err
	}

	log.Printf("matched ingested_id=%d event_id=%s rule_id=%d rule=%q", event.ID, event.EventID, rule.ID, rule.RuleName)
	return m.finishEvent(ctx, event.ID, "processed", nil)
}

func (m *Matcher) insertAlertEvent(ctx context.Context, event Event, rule Rule) (int64, *NotificationChannel, error) {
	const q = `
INSERT INTO alert_events (
  account_id,
  region_code,
  event_source,
  event_name,
  severity,
  event_time,
  resource_id,
  resource_name,
  user_arn,
  source_ip,
  raw_event_json,
  alert_status,
  source_ingested_event_id,
  matched_rule_id,
  matched_rule_name_snapshot,
  matched_rule_snapshot_json,
  notification_route_id,
  notification_channel_id
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18
)
ON CONFLICT (source_ingested_event_id) DO UPDATE
SET source_ingested_event_id = EXCLUDED.source_ingested_event_id
RETURNING id
`
	channel, err := m.resolveNotificationChannel(ctx, event, rule)
	if err != nil {
		return 0, nil, err
	}
	var channelID any
	if channel != nil {
		channelID = channel.ID
	}
	ruleSnapshot := ruleSnapshotJSON(rule)
	var alertEventID int64
	err = m.db.QueryRow(ctx, q,
		event.AccountID,
		nullIfEmpty(event.RegionCode),
		nullIfEmpty(event.EventSource),
		event.EventName,
		nonEmpty(rule.Severity, m.defaultSeverity),
		event.EventTime,
		nullIfEmpty(event.ResourceID),
		nullIfEmpty(event.ResourceName),
		nullIfEmpty(event.UserArn),
		nullIfEmpty(event.SourceIP),
		jsonOrEmptyObject(event.RawEventJSON),
		"new",
		event.ID,
		rule.ID,
		nullIfEmpty(rule.RuleName),
		ruleSnapshot,
		rule.NotificationRouteID,
		channelID,
	).Scan(&alertEventID)
	if err != nil {
		return 0, nil, err
	}
	return alertEventID, channel, nil
}

func (m *Matcher) updateAlertNotificationStatus(ctx context.Context, alertEventID int64, channelID *int64, status string, notifiedAt *time.Time, notificationError any) error {
	const q = `
UPDATE alert_events
SET alert_status = $2,
    notification_channel_id = COALESCE($3, notification_channel_id),
    notified_at = $4,
    notification_error = $5
WHERE id = $1`
	_, err := m.db.Exec(ctx, q, alertEventID, status, channelID, notifiedAt, notificationError)
	return err
}

func (m *Matcher) resolveNotificationChannel(ctx context.Context, event Event, rule Rule) (*NotificationChannel, error) {
	queries := []struct {
		query string
		args  []any
	}{}
	if rule.NotificationRouteID != nil {
		queries = append(queries, struct {
			query string
			args  []any
		}{
			query: `
SELECT nc.id, nc.channel_name, nc.channel_type, nc.bot_token, nc.chat_id
FROM account_notification_routes anr
JOIN notification_channels nc ON nc.id = anr.channel_id
WHERE anr.id = $1 AND anr.enabled = TRUE AND nc.enabled = TRUE
LIMIT 1`,
			args: []any{*rule.NotificationRouteID},
		})
	}
	queries = append(queries,
		struct {
			query string
			args  []any
		}{
			query: `
SELECT nc.id, nc.channel_name, nc.channel_type, nc.bot_token, nc.chat_id
FROM account_notification_routes anr
JOIN notification_channels nc ON nc.id = anr.channel_id
WHERE anr.account_id = $1 AND anr.enabled = TRUE AND nc.enabled = TRUE
ORDER BY anr.id ASC
LIMIT 1`,
			args: []any{event.AccountID},
		},
		struct {
			query string
			args  []any
		}{
			query: `
SELECT id, channel_name, channel_type, bot_token, chat_id
FROM notification_channels
WHERE enabled = TRUE
ORDER BY id ASC
LIMIT 1`,
			args: nil,
		},
	)

	for _, item := range queries {
		var channel NotificationChannel
		var botToken sql.NullString
		var chatID sql.NullString
		err := m.db.QueryRow(ctx, item.query, item.args...).Scan(&channel.ID, &channel.ChannelName, &channel.ChannelType, &botToken, &chatID)
		if err == pgx.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, err
		}
		channel.BotToken = botToken.String
		channel.ChatID = chatID.String
		return &channel, nil
	}

	return nil, nil
}

func sendNotification(channel NotificationChannel, event Event, rule Rule) error {
	if !strings.EqualFold(strings.TrimSpace(channel.ChannelType), "telegram") {
		return fmt.Errorf("unsupported channel type: %s", channel.ChannelType)
	}
	if strings.TrimSpace(channel.BotToken) == "" || strings.TrimSpace(channel.ChatID) == "" {
		return fmt.Errorf("telegram channel missing bot token or chat id")
	}

	text := fmt.Sprintf(
		"🚨 SOC 告警事件\n规则: %s\n事件ID: %s\n事件名: %s\n事件源: %s\n账号: %s\n区域: %s\n资源类型: %s\n资源ID: %s\n操作人: %s\n源 IP: %s\n时间: %s\n等级: %s",
		nonEmpty(rule.RuleName, fmt.Sprintf("rule-%d", rule.ID)),
		nonEmpty(event.EventID, "unknown"),
		nonEmpty(event.EventName, "unknown"),
		nonEmpty(event.EventSource, "unknown"),
		nonEmpty(event.AccountID, "unknown"),
		nonEmpty(event.RegionCode, "unknown"),
		nonEmpty(event.ResourceType, "unknown"),
		nonEmpty(event.ResourceID, "unknown"),
		nonEmpty(event.UserArn, "unknown"),
		nonEmpty(event.SourceIP, "unknown"),
		event.EventTime.Format(time.RFC3339),
		nonEmpty(rule.Severity, "medium"),
	)

	values := url.Values{}
	values.Set("chat_id", channel.ChatID)
	values.Set("text", text)

	resp, err := http.PostForm(fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", channel.BotToken), values)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("telegram http status %d", resp.StatusCode)
	}
	return nil
}

func timePtr(t time.Time) *time.Time { return &t }

func (m *Matcher) isCooldownHit(ctx context.Context, event Event, rule Rule) (bool, error) {
	const q = `
SELECT 1
FROM alert_events
WHERE matched_rule_id = $1
  AND account_id = $2
  AND event_name = $3
  AND COALESCE(resource_id, '') = COALESCE($4, '')
  AND event_time >= $5
LIMIT 1
`
	var exists int
	since := event.EventTime.Add(-time.Duration(rule.CooldownSeconds) * time.Second)
	err := m.db.QueryRow(ctx, q, rule.ID, event.AccountID, event.EventName, nullIfEmpty(event.ResourceID), since).Scan(&exists)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (m *Matcher) finishEvent(ctx context.Context, id int64, status string, processError any) error {
	const q = `UPDATE ingested_events SET process_status = $2, process_error = $3 WHERE id = $1`
	_, err := m.db.Exec(ctx, q, id, status, processError)
	return err
}

func (m *Matcher) failEvent(ctx context.Context, id int64, processError string) error {
	return m.finishEvent(ctx, id, "failed", truncate(processError, 2000))
}

func (c *RuleCache) RefreshIfNeeded(ctx context.Context, db *pgxpool.Pool) error {
	var currentVersion int64
	if err := db.QueryRow(ctx, `SELECT version FROM rule_config_state WHERE scope = 'alert_rules'`).Scan(&currentVersion); err != nil {
		return err
	}

	c.mu.RLock()
	fresh := !c.loadedAt.IsZero() && time.Since(c.loadedAt) < c.ttl
	versionUnchanged := c.version == currentVersion
	c.mu.RUnlock()
	if fresh && versionUnchanged {
		return nil
	}

	rows, err := db.Query(ctx, `
SELECT id, rule_name, account_id, region_code, event_source, event_name, resource_type,
       resource_pattern, user_arn_pattern, source_ip_pattern, severity, cooldown_seconds, notification_route_id
FROM alert_rules
WHERE enabled = TRUE
ORDER BY id ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()

	next := make(map[string][]Rule)
	count := 0
	for rows.Next() {
		var r Rule
		var regionCode sql.NullString
		var resourceType sql.NullString
		var resourcePattern sql.NullString
		var userArnPattern sql.NullString
		var sourceIPPattern sql.NullString
		var severity sql.NullString
		var notificationRouteID sql.NullInt64
		if err := rows.Scan(
			&r.ID,
			&r.RuleName,
			&r.AccountID,
			&regionCode,
			&r.EventSource,
			&r.EventName,
			&resourceType,
			&resourcePattern,
			&userArnPattern,
			&sourceIPPattern,
			&severity,
			&r.CooldownSeconds,
			&notificationRouteID,
		); err != nil {
			return err
		}
		r.RegionCode = regionCode.String
		r.ResourceType = resourceType.String
		r.ResourcePattern = resourcePattern.String
		r.UserArnPattern = userArnPattern.String
		r.SourceIPPattern = sourceIPPattern.String
		r.Severity = severity.String
		if notificationRouteID.Valid {
			value := notificationRouteID.Int64
			r.NotificationRouteID = &value
		}
		var compileErr error
		if r.compiledResource, compileErr = compileWildcardList(r.ResourcePattern); compileErr != nil {
			return fmt.Errorf("rule %d resource_pattern invalid: %w", r.ID, compileErr)
		}
		if r.compiledUserArn, compileErr = compileWildcardList(r.UserArnPattern); compileErr != nil {
			return fmt.Errorf("rule %d user_arn_pattern invalid: %w", r.ID, compileErr)
		}
		if r.compiledSourceIP, compileErr = compileWildcardList(r.SourceIPPattern); compileErr != nil {
			return fmt.Errorf("rule %d source_ip_pattern invalid: %w", r.ID, compileErr)
		}
		key := lookupKey(r.AccountID, r.EventSource, r.EventName)
		next[key] = append(next[key], r)
		count++
	}
	if err := rows.Err(); err != nil {
		return err
	}

	c.mu.Lock()
	c.byLookupKey = next
	c.loadedAt = time.Now()
	c.version = currentVersion
	c.mu.Unlock()
	log.Printf("rule cache refreshed rules=%d version=%d", count, currentVersion)
	return nil
}

func ruleSnapshotJSON(rule Rule) string {
	return fmt.Sprintf(`{"id":%d,"rule_name":%q,"account_id":%q,"region_code":%q,"event_source":%q,"event_name":%q,"resource_type":%q,"resource_pattern":%q,"user_arn_pattern":%q,"source_ip_pattern":%q,"severity":%q,"cooldown_seconds":%d,"notification_route_id":%s}`,
		rule.ID,
		rule.RuleName,
		rule.AccountID,
		rule.RegionCode,
		rule.EventSource,
		rule.EventName,
		rule.ResourceType,
		rule.ResourcePattern,
		rule.UserArnPattern,
		rule.SourceIPPattern,
		rule.Severity,
		rule.CooldownSeconds,
		nullJSONInt64(rule.NotificationRouteID),
	)
}

func nullJSONInt64(value *int64) string {
	if value == nil {
		return "null"
	}
	return strconv.FormatInt(*value, 10)
}

func (c *RuleCache) Lookup(event Event) []Rule {
	keys := []string{
		lookupKey(event.AccountID, event.EventSource, event.EventName),
		lookupKey("*", event.EventSource, event.EventName),
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]Rule, 0)
	for _, key := range keys {
		out = append(out, c.byLookupKey[key]...)
	}
	return out
}

func ruleMatches(rule Rule, event Event) bool {
	if !stringEquals(rule.RegionCode, event.RegionCode) {
		return false
	}
	if !stringEquals(rule.ResourceType, event.ResourceType) {
		return false
	}
	if !matchCompiled(event.ResourceID, rule.compiledResource) && !matchCompiled(event.ResourceName, rule.compiledResource) {
		return false
	}
	if !matchCompiled(event.UserArn, rule.compiledUserArn) {
		return false
	}
	if !matchCompiled(event.SourceIP, rule.compiledSourceIP) {
		return false
	}
	return true
}

func ruleSpecificity(rule Rule) int {
	score := 0
	if nonWildcard(rule.AccountID) {
		score += 1
	}
	if nonWildcard(rule.RegionCode) {
		score += 2
	}
	if nonWildcard(rule.ResourceType) {
		score += 2
	}
	if strings.TrimSpace(rule.ResourcePattern) != "" {
		score += 4
	}
	if strings.TrimSpace(rule.UserArnPattern) != "" {
		score += 2
	}
	if strings.TrimSpace(rule.SourceIPPattern) != "" {
		score += 1
	}
	return score
}

func compileWildcardList(pattern string) ([]*regexp.Regexp, error) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return nil, nil
	}
	parts := strings.FieldsFunc(pattern, func(r rune) bool {
		return r == '\n' || r == '\r' || r == ','
	})
	compiled := make([]*regexp.Regexp, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		re, err := regexp.Compile("(?i)^" + wildcardToRegex(part) + "$")
		if err != nil {
			return nil, err
		}
		compiled = append(compiled, re)
	}
	return compiled, nil
}

func wildcardToRegex(pattern string) string {
	var b strings.Builder
	for _, r := range pattern {
		if r == '*' {
			b.WriteString(".*")
			continue
		}
		b.WriteString(regexp.QuoteMeta(string(r)))
	}
	return b.String()
}

func matchCompiled(value string, patterns []*regexp.Regexp) bool {
	if len(patterns) == 0 {
		return true
	}
	if strings.TrimSpace(value) == "" {
		return false
	}
	for _, re := range patterns {
		if re.MatchString(value) {
			return true
		}
	}
	return false
}

func stringEquals(ruleValue, eventValue string) bool {
	ruleValue = strings.TrimSpace(ruleValue)
	if ruleValue == "" || ruleValue == "*" {
		return true
	}
	return strings.EqualFold(ruleValue, strings.TrimSpace(eventValue))
}

func lookupKey(accountID, eventSource, eventName string) string {
	return strings.ToLower(strings.TrimSpace(accountID)) + "|" + strings.ToLower(strings.TrimSpace(eventSource)) + "|" + strings.ToLower(strings.TrimSpace(eventName))
}

func nonWildcard(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && value != "*"
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func jsonOrEmptyObject(raw []byte) []byte {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return []byte(`{}`)
	}
	return raw
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit]
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		log.Printf("invalid int env %s=%q using default %d", key, value, fallback)
		return fallback
	}
	return parsed
}
