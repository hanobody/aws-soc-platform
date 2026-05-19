package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/athena"
	athenatypes "github.com/aws/aws-sdk-go-v2/service/athena/types"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultAWSRegion         = "ap-southeast-1"
	defaultQueueURL          = "https://sqs.ap-southeast-1.amazonaws.com/809893975949/soc-cloudtrail-events"
	defaultDatabaseURL       = "postgresql://soc_admin:soc_dev_password@localhost:5433/soc_platform"
	defaultAthenaTable       = "cloudtrail_logs"
	defaultS3PollIntervalMin = 5
)

var allowedEC2InstanceEvents = map[string]bool{
	"RunInstances":            true,
	"StartInstances":          true,
	"StopInstances":           true,
	"RebootInstances":         true,
	"TerminateInstances":      true,
	"ModifyInstanceAttribute": true,
	"MonitorInstances":        true,
	"UnmonitorInstances":      true,
}

var allowedSecurityGroupEvents = map[string]bool{
	"CreateSecurityGroup":                     true,
	"DeleteSecurityGroup":                     true,
	"AuthorizeSecurityGroupIngress":           true,
	"RevokeSecurityGroupIngress":              true,
	"AuthorizeSecurityGroupEgress":            true,
	"RevokeSecurityGroupEgress":               true,
	"ModifySecurityGroupRules":                true,
	"UpdateSecurityGroupRuleDescriptionsIngress": true,
	"UpdateSecurityGroupRuleDescriptionsEgress":  true,
}

var allowedSTSRoleEvents = map[string]bool{
	"AssumeRole":                true,
	"AssumeRoleWithSAML":        true,
	"AssumeRoleWithWebIdentity": true,
}

type CloudTrailEnvelope struct {
	SchemaVersion string    `json:"schema_version"`
	EventID       string    `json:"event_id"`
	DedupKey      string    `json:"dedup_key"`
	IngestSource  string    `json:"ingest_source"`
	IngestTime    time.Time `json:"ingest_time"`
	AWS           struct {
		AccountID string `json:"account_id"`
		Region    string `json:"region"`
		Partition string `json:"partition"`
	} `json:"aws"`
	Event struct {
		Source        string    `json:"source"`
		DetailType    string    `json:"detail_type"`
		EventSource   string    `json:"event_source"`
		EventName     string    `json:"event_name"`
		EventTime     time.Time `json:"event_time"`
		EventCategory string    `json:"event_category"`
		ReadOnly      *bool     `json:"read_only"`
	} `json:"event"`
	Actor struct {
		PrincipalType string `json:"principal_type"`
		ARN           string `json:"arn"`
		AccountID     string `json:"account_id"`
		UserName      string `json:"user_name"`
		AccessKeyID   string `json:"access_key_id"`
	} `json:"actor"`
	Network struct {
		SourceIP  string `json:"source_ip"`
		UserAgent string `json:"user_agent"`
	} `json:"network"`
	Resource struct {
		ResourceType string `json:"resource_type"`
		ResourceID   string `json:"resource_id"`
		ResourceName string `json:"resource_name"`
		ResourceARN  string `json:"resource_arn"`
	} `json:"resource"`
	Request struct {
		RequestID         string          `json:"request_id"`
		RequestParameters json.RawMessage `json:"request_parameters"`
		ResponseElements  json.RawMessage `json:"response_elements"`
	} `json:"request"`
	RawEvent json.RawMessage `json:"raw_event"`
}

type AthenaTarget struct {
	AccountID string   `json:"accountId"`
	Regions   []string `json:"regions"`
}

type RuntimeConfig struct {
	SourceMode            string
	QueueURL              string
	BatchSize             int32
	WaitTime              int32
	Visibility            int32
	S3PollIntervalMinutes int
	S3Targets             []AthenaTarget
	AthenaDatabase        string
	AthenaWorkGroup       string
	AthenaOutputLocation  string
}

type Consumer struct {
	sqsClient    *sqs.Client
	athenaClient *athena.Client
	db           *pgxpool.Pool
	workerName   string
	configMu     sync.RWMutex
	config       RuntimeConfig
}

type athenaQueryRow struct {
	EventID               string
	EventTime             string
	Account               string
	Region                string
	EventSource           string
	EventName             string
	ReadOnly              string
	PrincipalType         string
	PrincipalArn          string
	PrincipalAccountID    string
	PrincipalUserName     string
	PrincipalAccessKeyID  string
	SourceIPAddress       string
	UserAgent             string
	RequestID             string
	RequestParameters     string
	ResponseElements      string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	region := envOrDefault("AWS_REGION", defaultAWSRegion)
	queueURL := envOrDefault("SQS_QUEUE_URL", defaultQueueURL)
	databaseURL := envOrDefault("DATABASE_URL", defaultDatabaseURL)
	batchSize := int32(envInt("SQS_MAX_MESSAGES", 10))
	waitTime := int32(envInt("SQS_WAIT_SECONDS", 20))
	visibility := int32(envInt("SQS_VISIBILITY_TIMEOUT", 120))

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		log.Fatalf("load aws config: %v", err)
	}

	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer db.Close()

	consumer := &Consumer{
		sqsClient:    sqs.NewFromConfig(awsCfg),
		athenaClient: athena.NewFromConfig(awsCfg),
		db:           db,
		workerName:   envOrDefault("WORKER_NAME", "ingest-worker"),
		config: RuntimeConfig{
			SourceMode:            "sqs",
			QueueURL:              queueURL,
			BatchSize:             batchSize,
			WaitTime:              waitTime,
			Visibility:            visibility,
			S3PollIntervalMinutes: defaultS3PollIntervalMin,
		},
	}

	if err := consumer.ensureWorkerStatusTable(ctx); err != nil {
		log.Fatalf("ensure worker status table: %v", err)
	}
	if err := consumer.ensureCheckpointTable(ctx); err != nil {
		log.Fatalf("ensure checkpoint table: %v", err)
	}
	if err := consumer.reloadRuntimeConfig(ctx); err != nil {
		log.Printf("initial runtime config load failed, using defaults: %v", err)
	}

	go consumer.heartbeatLoop(ctx)
	startupConfig := consumer.getRuntimeConfig()
	_ = consumer.updateWorkerStatus(context.Background(), "starting", startupMessage(startupConfig, region))
	defer func() {
		_ = consumer.updateWorkerStatus(context.Background(), "stopped", "consumer stopped")
	}()

	log.Printf("ingest worker started mode=%s region=%s", startupConfig.SourceMode, region)
	if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("consumer stopped with error: %v", err)
	}
	log.Printf("ingest worker stopped")
}

func startupMessage(cfg RuntimeConfig, region string) string {
	if cfg.SourceMode == "s3" {
		return fmt.Sprintf("mode=%s poll=%dm athenaDb=%s region=%s", cfg.SourceMode, cfg.S3PollIntervalMinutes, cfg.AthenaDatabase, region)
	}
	return fmt.Sprintf("mode=%s queue=%s region=%s", cfg.SourceMode, cfg.QueueURL, region)
}

func (c *Consumer) Run(ctx context.Context) error {
	reloadTicker := time.NewTicker(10 * time.Second)
	defer reloadTicker.Stop()
	lastS3Run := time.Time{}

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		select {
		case <-reloadTicker.C:
			if err := c.reloadRuntimeConfig(ctx); err != nil {
				log.Printf("reload runtime config failed: %v", err)
			}
		default:
		}

		cfg := c.getRuntimeConfig()
		if cfg.SourceMode == "s3" {
			runAt, ok := shouldRunS3(lastS3Run, cfg.S3PollIntervalMinutes)
			if !ok {
				sleepWithContext(ctx, 3*time.Second)
				continue
			}
			status, message, err := c.runS3Mode(ctx, cfg)
			if err != nil {
				log.Printf("s3 mode run failed: %v", err)
				_ = c.updateWorkerStatus(ctx, status, message)
				sleepWithContext(ctx, 5*time.Second)
				continue
			}
			_ = c.updateWorkerStatus(ctx, status, message)
			lastS3Run = runAt
			sleepWithContext(ctx, 2*time.Second)
			continue
		}

		status, message, err := c.runSQSMode(ctx, cfg)
		if err != nil {
			_ = c.updateWorkerStatus(ctx, "error", message)
			return err
		}
		_ = c.updateWorkerStatus(ctx, status, message)
	}
}

func shouldRunS3(lastRun time.Time, intervalMinutes int) (time.Time, bool) {
	now := time.Now().UTC()
	interval := time.Duration(clamp(intervalMinutes, 1, 1440)) * time.Minute
	if lastRun.IsZero() || now.Sub(lastRun) >= interval {
		return now, true
	}
	return lastRun, false
}

func (c *Consumer) runSQSMode(ctx context.Context, cfg RuntimeConfig) (string, string, error) {
	statusMessage := fmt.Sprintf("polling SQS queue=%s batch=%d wait=%d visibility=%d", cfg.QueueURL, cfg.BatchSize, cfg.WaitTime, cfg.Visibility)
	resp, err := c.sqsClient.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:              &cfg.QueueURL,
		MaxNumberOfMessages:   cfg.BatchSize,
		WaitTimeSeconds:       cfg.WaitTime,
		VisibilityTimeout:     cfg.Visibility,
		MessageAttributeNames: []string{"All"},
		AttributeNames:        []types.QueueAttributeName{types.QueueAttributeNameAll},
	})
	if err != nil {
		return "error", fmt.Sprintf("receive message failed: %v", err), fmt.Errorf("receive message: %w", err)
	}

	if len(resp.Messages) == 0 {
		return "running", statusMessage, nil
	}

	processed := 0
	for _, msg := range resp.Messages {
		if err := c.handleMessage(ctx, msg, cfg.QueueURL); err != nil {
			log.Printf("handle message failed id=%s err=%v", deref(msg.MessageId), err)
			continue
		}
		processed++
	}

	return "running", fmt.Sprintf("processed %d SQS messages", processed), nil
}

func (c *Consumer) runS3Mode(ctx context.Context, cfg RuntimeConfig) (string, string, error) {
	if strings.TrimSpace(cfg.AthenaDatabase) == "" || strings.TrimSpace(cfg.AthenaOutputLocation) == "" {
		return "paused", "s3 mode idle: Athena 数据库或结果输出路径未配置", nil
	}

	targets := normalizeTargets(cfg.S3Targets)
	if len(targets) == 0 {
		return "paused", "s3 mode idle: 未选择任何账号或区域", nil
	}

	totalInserted := 0
	totalQueries := 0
	windowMinutes := maxInt(cfg.S3PollIntervalMinutes*3, 15)
	overlapMinutes := maxInt(cfg.S3PollIntervalMinutes, 5)
	now := time.Now().UTC()

	for _, target := range targets {
		for _, region := range target.Regions {
			startAt, endAt, err := c.computeWindow(ctx, target.AccountID, region, now, windowMinutes, overlapMinutes)
			if err != nil {
				return "error", fmt.Sprintf("compute window failed account=%s region=%s err=%v", target.AccountID, region, err), err
			}

			inserted, err := c.queryAthenaAndIngestWithRetry(ctx, cfg, target.AccountID, region, startAt, endAt)
			if err != nil {
				return "degraded", fmt.Sprintf("Athena ingest failed account=%s region=%s err=%v", target.AccountID, region, err), err
			}
			totalInserted += inserted
			totalQueries++

			if err := c.saveCheckpoint(ctx, target.AccountID, region, endAt); err != nil {
				return "error", fmt.Sprintf("save checkpoint failed account=%s region=%s err=%v", target.AccountID, region, err), err
			}
		}
	}

	return "running", fmt.Sprintf("s3 mode Athena sync done queries=%d inserted=%d targets=%d", totalQueries, totalInserted, len(targets)), nil
}

func (c *Consumer) queryAthenaAndIngestWithRetry(ctx context.Context, cfg RuntimeConfig, accountID, region string, startAt, endAt time.Time) (int, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		inserted, err := c.queryAthenaAndIngest(ctx, cfg, accountID, region, startAt, endAt)
		if err == nil {
			if attempt > 1 {
				log.Printf("Athena ingest recovered account=%s region=%s attempt=%d inserted=%d", accountID, region, attempt, inserted)
			}
			return inserted, nil
		}
		lastErr = err
		log.Printf("Athena ingest attempt failed account=%s region=%s attempt=%d err=%v", accountID, region, attempt, err)
		if attempt < 3 {
			sleepWithContext(ctx, time.Duration(attempt*2)*time.Second)
		}
	}
	return 0, lastErr
}

func (c *Consumer) computeWindow(ctx context.Context, accountID, region string, now time.Time, windowMinutes, overlapMinutes int) (time.Time, time.Time, error) {
	checkpoint, err := c.getCheckpoint(ctx, accountID, region)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	endAt := now
	if checkpoint == nil || checkpoint.IsZero() {
		return now.Add(-time.Duration(windowMinutes) * time.Minute), endAt, nil
	}
	startAt := checkpoint.Add(-time.Duration(overlapMinutes) * time.Minute)
	if startAt.After(endAt) {
		startAt = endAt.Add(-time.Duration(overlapMinutes) * time.Minute)
	}
	return startAt, endAt, nil
}

func (c *Consumer) queryAthenaAndIngest(ctx context.Context, cfg RuntimeConfig, accountID, region string, startAt, endAt time.Time) (int, error) {
	queryString := buildAthenaIncrementalSQL(cfg.AthenaDatabase, accountID, region, startAt, endAt)
	log.Printf("Athena incremental query account=%s region=%s start=%s end=%s", accountID, region, startAt.Format(time.RFC3339), endAt.Format(time.RFC3339))
	executionID, err := c.startAndWaitAthenaQuery(ctx, cfg, queryString)
	if err != nil {
		return 0, err
	}

	rows, err := c.fetchAthenaRows(ctx, executionID)
	if err != nil {
		return 0, err
	}

	inserted := 0
	for _, row := range rows {
		envelope, err := mapAthenaRowToEnvelope(row)
		if err != nil {
			log.Printf("skip invalid Athena row account=%s region=%s event=%s err=%v", accountID, region, row.EventID, err)
			continue
		}
		ok, err := c.insertEvent(ctx, envelope)
		if err != nil {
			return inserted, err
		}
		if ok {
			inserted++
		}
	}
	log.Printf("Athena ingest completed account=%s region=%s executionId=%s rows=%d inserted=%d", accountID, region, executionID, len(rows), inserted)

	return inserted, nil
}

func (c *Consumer) startAndWaitAthenaQuery(ctx context.Context, cfg RuntimeConfig, queryString string) (string, error) {
	input := &athena.StartQueryExecutionInput{
		QueryString: &queryString,
		QueryExecutionContext: &athenatypes.QueryExecutionContext{
			Database: &cfg.AthenaDatabase,
		},
		ResultConfiguration: &athenatypes.ResultConfiguration{
			OutputLocation: &cfg.AthenaOutputLocation,
		},
	}
	if strings.TrimSpace(cfg.AthenaWorkGroup) != "" {
		input.WorkGroup = &cfg.AthenaWorkGroup
	}

	startResp, err := c.athenaClient.StartQueryExecution(ctx, input)
	if err != nil {
		return "", fmt.Errorf("start athena query: %w", err)
	}
	if startResp.QueryExecutionId == nil || *startResp.QueryExecutionId == "" {
		return "", fmt.Errorf("start athena query returned empty execution id")
	}
	executionID := *startResp.QueryExecutionId

	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(2 * time.Second):
		}

		statusResp, err := c.athenaClient.GetQueryExecution(ctx, &athena.GetQueryExecutionInput{QueryExecutionId: &executionID})
		if err != nil {
			return "", fmt.Errorf("get athena query execution: %w", err)
		}
		state := string(statusResp.QueryExecution.Status.State)
		switch statusResp.QueryExecution.Status.State {
		case athenatypes.QueryExecutionStateSucceeded:
			return executionID, nil
		case athenatypes.QueryExecutionStateFailed, athenatypes.QueryExecutionStateCancelled:
			reason := deref(statusResp.QueryExecution.Status.StateChangeReason)
			return "", fmt.Errorf("athena query %s: %s", state, reason)
		}
	}
}

func (c *Consumer) fetchAthenaRows(ctx context.Context, executionID string) ([]athenaQueryRow, error) {
	rows := []athenaQueryRow{}
	var nextToken *string
	firstPage := true

	for {
		resp, err := c.athenaClient.GetQueryResults(ctx, &athena.GetQueryResultsInput{
			QueryExecutionId: &executionID,
			NextToken:        nextToken,
			MaxResults:       int32Ptr(1000),
		})
		if err != nil {
			return nil, fmt.Errorf("get athena query results: %w", err)
		}

		pageRows := resp.ResultSet.Rows
		if firstPage && len(pageRows) > 0 {
			pageRows = pageRows[1:]
			firstPage = false
		}

		for _, row := range pageRows {
			values := flattenAthenaRow(row)
			rows = append(rows, athenaQueryRow{
				EventID:              values[0],
				EventTime:            values[1],
				Account:              values[2],
				Region:               values[3],
				EventSource:          values[4],
				EventName:            values[5],
				ReadOnly:             values[6],
				PrincipalType:        values[7],
				PrincipalArn:         values[8],
				PrincipalAccountID:   values[9],
				PrincipalUserName:    values[10],
				PrincipalAccessKeyID: values[11],
				SourceIPAddress:      values[12],
				UserAgent:            values[13],
				RequestID:            values[14],
				RequestParameters:    values[15],
				ResponseElements:     values[16],
			})
		}

		if resp.NextToken == nil || *resp.NextToken == "" {
			break
		}
		nextToken = resp.NextToken
	}

	return rows, nil
}

func flattenAthenaRow(row athenatypes.Row) []string {
	values := make([]string, 17)
	for i := range values {
		if i < len(row.Data) && row.Data[i].VarCharValue != nil {
			values[i] = *row.Data[i].VarCharValue
		}
	}
	return values
}

func mapAthenaRowToEnvelope(row athenaQueryRow) (CloudTrailEnvelope, error) {
	var envelope CloudTrailEnvelope
	if strings.TrimSpace(row.EventID) == "" {
		return envelope, fmt.Errorf("missing event id")
	}
	eventTime, err := parseAthenaTime(row.EventTime)
	if err != nil {
		return envelope, fmt.Errorf("parse event time: %w", err)
	}

	envelope.SchemaVersion = "cloudtrail.event.v1"
	envelope.EventID = row.EventID
	envelope.DedupKey = fmt.Sprintf("athena:%s:%s:%s", nonEmpty(row.Account, "unknown"), nonEmpty(row.Region, "unknown"), row.EventID)
	envelope.IngestSource = "athena.cloudtrail"
	envelope.IngestTime = time.Now().UTC()
	envelope.AWS.AccountID = row.Account
	envelope.AWS.Region = row.Region
	envelope.AWS.Partition = "aws"
	envelope.Event.Source = "aws.cloudtrail"
	envelope.Event.DetailType = "CloudTrail via Athena"
	envelope.Event.EventSource = row.EventSource
	envelope.Event.EventName = row.EventName
	envelope.Event.EventTime = eventTime
	envelope.Event.EventCategory = "Management"
	envelope.Event.ReadOnly = parseOptionalBool(row.ReadOnly)
	envelope.Actor.PrincipalType = row.PrincipalType
	envelope.Actor.ARN = row.PrincipalArn
	envelope.Actor.AccountID = row.PrincipalAccountID
	envelope.Actor.UserName = row.PrincipalUserName
	envelope.Actor.AccessKeyID = row.PrincipalAccessKeyID
	envelope.Network.SourceIP = row.SourceIPAddress
	envelope.Network.UserAgent = row.UserAgent
	envelope.Request.RequestID = row.RequestID
	envelope.Request.RequestParameters = rawJSONOrNil(row.RequestParameters)
	envelope.Request.ResponseElements = rawJSONOrNil(row.ResponseElements)
	envelope.RawEvent = buildSyntheticRawEvent(row)

	resourceType := inferResourceTypeFromRequest(row.EventName, row.EventSource, row.RequestParameters, row.ResponseElements)
	resourceID, resourceName := extractResourceFromRequest(row.EventName, row.EventSource, row.RequestParameters, row.ResponseElements)
	envelope.Resource.ResourceType = resourceType
	envelope.Resource.ResourceID = resourceID
	envelope.Resource.ResourceName = resourceName
	normalizeScopedEnvelope(&envelope)

	return envelope, nil
}

func buildAthenaIncrementalSQL(database, accountID, region string, startAt, endAt time.Time) string {
	partitionClauses := buildDatePartitionClauses(startAt, endAt)
	eventScopeClauses := buildAthenaEventScopeSQL()
	return fmt.Sprintf(`SELECT
  eventid,
  eventtime,
  account,
  region,
  eventsource,
  eventname,
  readonly,
  useridentity.type AS principal_type,
  useridentity.arn AS principal_arn,
  useridentity.accountid AS principal_account_id,
  useridentity.username AS principal_username,
  useridentity.accesskeyid AS principal_access_key_id,
  sourceipaddress,
  useragent,
  requestid,
  requestparameters,
  responseelements
FROM %s.%s
WHERE account = '%s'
  AND region = '%s'
  AND (%s)
  AND (%s)
  AND from_iso8601_timestamp(eventtime) >= from_iso8601_timestamp('%s')
  AND from_iso8601_timestamp(eventtime) < from_iso8601_timestamp('%s')
ORDER BY eventtime ASC`,
		sanitizeIdentifier(database),
		defaultAthenaTable,
		escapeSQLString(accountID),
		escapeSQLString(region),
		eventScopeClauses,
		partitionClauses,
		startAt.Format(time.RFC3339),
		endAt.Format(time.RFC3339),
	)
}

func buildAthenaEventScopeSQL() string {
	ec2InstanceEvents := quoteSQLList(sortedAllowedEventNames(allowedEC2InstanceEvents))
	securityGroupEvents := quoteSQLList(sortedAllowedEventNames(allowedSecurityGroupEvents))
	stsRoleEvents := quoteSQLList(sortedAllowedEventNames(allowedSTSRoleEvents))
	return fmt.Sprintf("(eventsource = 'iam.amazonaws.com') OR (eventsource = 'sts.amazonaws.com' AND eventname IN (%s)) OR (eventsource = 'ec2.amazonaws.com' AND eventname IN (%s, %s))", stsRoleEvents, ec2InstanceEvents, securityGroupEvents)
}

func buildDatePartitionClauses(startAt, endAt time.Time) string {
	clauses := []string{}
	seen := map[string]bool{}
	day := time.Date(startAt.Year(), startAt.Month(), startAt.Day(), 0, 0, 0, 0, time.UTC)
	endDay := time.Date(endAt.Year(), endAt.Month(), endAt.Day(), 0, 0, 0, 0, time.UTC)
	for !day.After(endDay) {
		key := day.Format("2006-01-02")
		if !seen[key] {
			seen[key] = true
			clauses = append(clauses, fmt.Sprintf("(year = '%04d' AND month = '%02d' AND day = '%02d')", day.Year(), day.Month(), day.Day()))
		}
		day = day.Add(24 * time.Hour)
	}
	return strings.Join(clauses, " OR ")
}

func normalizeTargets(targets []AthenaTarget) []AthenaTarget {
	result := []AthenaTarget{}
	seen := map[string]bool{}
	for _, target := range targets {
		accountID := strings.TrimSpace(target.AccountID)
		if accountID == "" {
			continue
		}
		regions := []string{}
		regionSeen := map[string]bool{}
		for _, region := range target.Regions {
			normalized := strings.TrimSpace(region)
			if normalized == "" || regionSeen[normalized] {
				continue
			}
			regionSeen[normalized] = true
			regions = append(regions, normalized)
		}
		if len(regions) == 0 {
			continue
		}
		sort.Strings(regions)
		key := accountID + "|" + strings.Join(regions, ",")
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, AthenaTarget{AccountID: accountID, Regions: regions})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].AccountID < result[j].AccountID })
	return result
}

func (c *Consumer) handleMessage(ctx context.Context, msg types.Message, queueURL string) error {
	body := deref(msg.Body)
	var envelope CloudTrailEnvelope
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		return fmt.Errorf("unmarshal body: %w", err)
	}

	if envelope.DedupKey == "" {
		return fmt.Errorf("missing dedup_key")
	}
	if envelope.EventID == "" {
		envelope.EventID = envelope.DedupKey
	}
	normalizeScopedEnvelope(&envelope)
	if !shouldIngestEvent(envelope.Event.EventSource, envelope.Event.EventName) {
		log.Printf("skip out-of-scope event=%s source=%s name=%s", envelope.EventID, envelope.Event.EventSource, envelope.Event.EventName)
		_, err := c.sqsClient.DeleteMessage(ctx, &sqs.DeleteMessageInput{
			QueueUrl:      &queueURL,
			ReceiptHandle: msg.ReceiptHandle,
		})
		if err != nil {
			return fmt.Errorf("delete skipped message: %w", err)
		}
		return nil
	}

	inserted, err := c.insertEvent(ctx, envelope)
	if err != nil {
		return err
	}

	_, err = c.sqsClient.DeleteMessage(ctx, &sqs.DeleteMessageInput{
		QueueUrl:      &queueURL,
		ReceiptHandle: msg.ReceiptHandle,
	})
	if err != nil {
		return fmt.Errorf("delete message: %w", err)
	}

	if inserted {
		log.Printf("ingested event=%s name=%s source=%s", envelope.EventID, envelope.Event.EventName, envelope.Event.EventSource)
	} else {
		log.Printf("duplicate skipped event=%s dedup=%s", envelope.EventID, envelope.DedupKey)
	}
	return nil
}

func (c *Consumer) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cfg := c.getRuntimeConfig()
			status := "running"
			message := fmt.Sprintf("heartbeat mode=%s queue=%s", cfg.SourceMode, cfg.QueueURL)
			if cfg.SourceMode == "s3" {
				targets := normalizeTargets(cfg.S3Targets)
				if len(targets) == 0 {
					status = "paused"
					message = "heartbeat mode=s3 idle: no account-region targets"
				} else {
					message = fmt.Sprintf("heartbeat mode=s3 poll=%dm targets=%d", cfg.S3PollIntervalMinutes, len(targets))
				}
			}
			_ = c.updateWorkerStatus(context.Background(), status, message)
		}
	}
}

func (c *Consumer) reloadRuntimeConfig(ctx context.Context) error {
	current := c.getRuntimeConfig()
	next := current

	sourceMode := c.getSetting(ctx, "ingest.sourceMode", current.SourceMode)
	queueURL := c.getSetting(ctx, "ingest.sqs.queueUrl", current.QueueURL)
	batchSize := envIntFromString(c.getSetting(ctx, "ingest.sqs.maxMessages", strconv.Itoa(int(current.BatchSize))), int(current.BatchSize))
	waitTime := envIntFromString(c.getSetting(ctx, "ingest.sqs.waitSeconds", strconv.Itoa(int(current.WaitTime))), int(current.WaitTime))
	visibility := envIntFromString(c.getSetting(ctx, "ingest.sqs.visibilityTimeout", strconv.Itoa(int(current.Visibility))), int(current.Visibility))
	pollInterval := envIntFromString(c.getSetting(ctx, "ingest.s3.pollIntervalMinutes", strconv.Itoa(maxInt(current.S3PollIntervalMinutes, defaultS3PollIntervalMin))), maxInt(current.S3PollIntervalMinutes, defaultS3PollIntervalMin))
	targets := c.getJSONSettingTargets(ctx, "ingest.s3.targets")
	athenaDatabase := c.getSetting(ctx, "athena.database", current.AthenaDatabase)
	athenaWorkGroup := c.getSetting(ctx, "athena.workgroup", current.AthenaWorkGroup)
	athenaOutputLocation := c.getSetting(ctx, "athena.outputLocation", current.AthenaOutputLocation)

	next.SourceMode = normalizeSourceMode(sourceMode)
	next.QueueURL = nonEmpty(queueURL, defaultQueueURL)
	next.BatchSize = int32(clamp(batchSize, 1, 10))
	next.WaitTime = int32(clamp(waitTime, 0, 20))
	next.Visibility = int32(clamp(visibility, 0, 43200))
	next.S3PollIntervalMinutes = clamp(pollInterval, 1, 1440)
	next.S3Targets = targets
	next.AthenaDatabase = strings.TrimSpace(athenaDatabase)
	next.AthenaWorkGroup = strings.TrimSpace(athenaWorkGroup)
	next.AthenaOutputLocation = strings.TrimSpace(athenaOutputLocation)

	c.configMu.Lock()
	c.config = next
	c.configMu.Unlock()

	if runtimeConfigChanged(current, next) {
		log.Printf("runtime config updated mode=%s queue=%s batch=%d wait=%d visibility=%d s3Poll=%d targets=%d athenaDb=%s", next.SourceMode, next.QueueURL, next.BatchSize, next.WaitTime, next.Visibility, next.S3PollIntervalMinutes, len(normalizeTargets(next.S3Targets)), next.AthenaDatabase)
	}
	return nil
}

func runtimeConfigChanged(current, next RuntimeConfig) bool {
	if current.SourceMode != next.SourceMode || current.QueueURL != next.QueueURL || current.BatchSize != next.BatchSize || current.WaitTime != next.WaitTime || current.Visibility != next.Visibility || current.S3PollIntervalMinutes != next.S3PollIntervalMinutes || current.AthenaDatabase != next.AthenaDatabase || current.AthenaWorkGroup != next.AthenaWorkGroup || current.AthenaOutputLocation != next.AthenaOutputLocation {
		return true
	}
	return stringifyJSON(current.S3Targets) != stringifyJSON(next.S3Targets)
}

func stringifyJSON(value any) string {
	bytes, _ := json.Marshal(value)
	return string(bytes)
}

func (c *Consumer) getRuntimeConfig() RuntimeConfig {
	c.configMu.RLock()
	defer c.configMu.RUnlock()
	return c.config
}

func (c *Consumer) getSetting(ctx context.Context, key, fallback string) string {
	var value *string
	err := c.db.QueryRow(ctx, `SELECT setting_value FROM app_settings WHERE setting_key = $1`, key).Scan(&value)
	if err != nil || value == nil || strings.TrimSpace(*value) == "" {
		return fallback
	}
	return strings.TrimSpace(*value)
}

func (c *Consumer) getJSONSettingTargets(ctx context.Context, key string) []AthenaTarget {
	raw := c.getSetting(ctx, key, "[]")
	targets := []AthenaTarget{}
	if err := json.Unmarshal([]byte(raw), &targets); err != nil {
		log.Printf("parse json setting %s failed: %v", key, err)
		return nil
	}
	return targets
}

func (c *Consumer) ensureWorkerStatusTable(ctx context.Context) error {
	const q = `
CREATE TABLE IF NOT EXISTS worker_status (
  worker_name VARCHAR(80) PRIMARY KEY,
  worker_type VARCHAR(80) NOT NULL,
  status VARCHAR(32) NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`
	_, err := c.db.Exec(ctx, q)
	return err
}

func (c *Consumer) ensureCheckpointTable(ctx context.Context) error {
	const q = `
CREATE TABLE IF NOT EXISTS ingest_worker_checkpoints (
  worker_name VARCHAR(80) NOT NULL,
  source_mode VARCHAR(32) NOT NULL,
  target_key VARCHAR(200) NOT NULL,
  checkpoint_time TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker_name, source_mode, target_key)
)`
	_, err := c.db.Exec(ctx, q)
	return err
}

func (c *Consumer) checkpointKey(accountID, region string) string {
	return fmt.Sprintf("%s|%s", accountID, region)
}

func (c *Consumer) getCheckpoint(ctx context.Context, accountID, region string) (*time.Time, error) {
	var checkpoint time.Time
	err := c.db.QueryRow(ctx, `
SELECT checkpoint_time
FROM ingest_worker_checkpoints
WHERE worker_name = $1 AND source_mode = 's3' AND target_key = $2
`, c.workerName, c.checkpointKey(accountID, region)).Scan(&checkpoint)
	if err != nil {
		return nil, nil
	}
	return &checkpoint, nil
}

func (c *Consumer) saveCheckpoint(ctx context.Context, accountID, region string, checkpoint time.Time) error {
	_, err := c.db.Exec(ctx, `
INSERT INTO ingest_worker_checkpoints (worker_name, source_mode, target_key, checkpoint_time, updated_at)
VALUES ($1, 's3', $2, $3, NOW())
ON CONFLICT (worker_name, source_mode, target_key) DO UPDATE
SET checkpoint_time = EXCLUDED.checkpoint_time,
    updated_at = EXCLUDED.updated_at
`, c.workerName, c.checkpointKey(accountID, region), checkpoint)
	return err
}

func (c *Consumer) updateWorkerStatus(ctx context.Context, status, message string) error {
	const q = `
INSERT INTO worker_status (worker_name, worker_type, status, last_heartbeat_at, last_message, updated_at)
VALUES ($1, 'ingest-worker', $2, NOW(), $3, NOW())
ON CONFLICT (worker_name) DO UPDATE
SET status = EXCLUDED.status,
    last_heartbeat_at = EXCLUDED.last_heartbeat_at,
    last_message = EXCLUDED.last_message,
    updated_at = EXCLUDED.updated_at`
	_, err := c.db.Exec(ctx, q, c.workerName, status, nullIfEmpty(message))
	return err
}

func (c *Consumer) insertEvent(ctx context.Context, e CloudTrailEnvelope) (bool, error) {
	const q = `
INSERT INTO ingested_events (
  schema_version, event_id, dedup_key, ingest_source, ingest_time,
  aws_account_id, aws_region, aws_partition,
  event_source, event_name, event_time, event_detail_type, event_category, read_only,
  actor_principal_type, actor_arn, actor_account_id, actor_user_name, actor_access_key_id,
  source_ip, user_agent,
  resource_type, resource_id, resource_name, resource_arn,
  request_id, request_parameters_json, response_elements_json,
  raw_event_json, process_status
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8,
  $9, $10, $11, $12, $13, $14,
  $15, $16, $17, $18, $19,
  $20, $21,
  $22, $23, $24, $25,
  $26, $27::jsonb, $28::jsonb,
  $29::jsonb, 'new'
)
ON CONFLICT (dedup_key) DO NOTHING
`

	cmd, err := c.db.Exec(ctx, q,
		nonEmpty(e.SchemaVersion, "cloudtrail.event.v1"),
		e.EventID,
		e.DedupKey,
		nonEmpty(e.IngestSource, "eventbridge.main-bus"),
		nonZeroTime(e.IngestTime),
		e.AWS.AccountID,
		nullIfEmpty(e.AWS.Region),
		nullIfEmpty(e.AWS.Partition),
		e.Event.EventSource,
		e.Event.EventName,
		nonZeroTime(e.Event.EventTime),
		nullIfEmpty(e.Event.DetailType),
		nullIfEmpty(e.Event.EventCategory),
		e.Event.ReadOnly,
		nullIfEmpty(e.Actor.PrincipalType),
		nullIfEmpty(e.Actor.ARN),
		nullIfEmpty(e.Actor.AccountID),
		nullIfEmpty(e.Actor.UserName),
		nullIfEmpty(e.Actor.AccessKeyID),
		nullIfEmpty(e.Network.SourceIP),
		nullIfEmpty(e.Network.UserAgent),
		nullIfEmpty(e.Resource.ResourceType),
		nullIfEmpty(e.Resource.ResourceID),
		nullIfEmpty(e.Resource.ResourceName),
		nullIfEmpty(e.Resource.ResourceARN),
		nullIfEmpty(e.Request.RequestID),
		jsonOrNull(e.Request.RequestParameters),
		jsonOrNull(e.Request.ResponseElements),
		jsonOrNull(e.RawEvent),
	)
	if err != nil {
		return false, fmt.Errorf("insert ingested event: %w", err)
	}
	return cmd.RowsAffected() > 0, nil
}

func parseAthenaTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	formats := []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999", "2006-01-02 15:04:05"}
	for _, format := range formats {
		if parsed, err := time.Parse(format, value); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported time format: %s", value)
}

func shouldIngestEvent(eventSource, eventName string) bool {
	source := strings.ToLower(strings.TrimSpace(eventSource))
	name := strings.TrimSpace(eventName)
	switch source {
	case "iam.amazonaws.com":
		return true
	case "sts.amazonaws.com":
		return allowedSTSRoleEvents[name]
	case "ec2.amazonaws.com":
		return allowedEC2InstanceEvents[name] || allowedSecurityGroupEvents[name]
	default:
		return false
	}
}

func normalizeScopedEnvelope(envelope *CloudTrailEnvelope) {
	if envelope == nil || !shouldIngestEvent(envelope.Event.EventSource, envelope.Event.EventName) {
		return
	}
	requestParameters := rawMessageString(envelope.Request.RequestParameters)
	responseElements := rawMessageString(envelope.Request.ResponseElements)
	resourceType := inferResourceTypeFromRequest(envelope.Event.EventName, envelope.Event.EventSource, requestParameters, responseElements)
	resourceID, resourceName := extractResourceFromRequest(envelope.Event.EventName, envelope.Event.EventSource, requestParameters, responseElements)
	if strings.TrimSpace(resourceType) != "" {
		envelope.Resource.ResourceType = resourceType
	}
	if strings.TrimSpace(resourceID) != "" {
		envelope.Resource.ResourceID = resourceID
	}
	if strings.TrimSpace(resourceName) != "" {
		envelope.Resource.ResourceName = resourceName
	}
	if strings.TrimSpace(envelope.Resource.ResourceARN) == "" && looksLikeARN(envelope.Resource.ResourceID) {
		envelope.Resource.ResourceARN = envelope.Resource.ResourceID
	}
}

func rawMessageString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func parseOptionalBool(value string) *bool {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	switch trimmed {
	case "true":
		v := true
		return &v
	case "false":
		v := false
		return &v
	default:
		return nil
	}
}

func rawJSONOrNil(value string) json.RawMessage {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	return json.RawMessage(trimmed)
}

func buildSyntheticRawEvent(row athenaQueryRow) json.RawMessage {
	payload := map[string]any{
		"eventID":          row.EventID,
		"eventTime":        row.EventTime,
		"recipientAccountId": row.Account,
		"awsRegion":        row.Region,
		"eventSource":      row.EventSource,
		"eventName":        row.EventName,
		"readOnly":         parseOptionalBoolValue(row.ReadOnly),
		"sourceIPAddress":  row.SourceIPAddress,
		"userAgent":        row.UserAgent,
		"requestID":        row.RequestID,
	}
	if parsed := parseJSONAny(row.RequestParameters); parsed != nil {
		payload["requestParameters"] = parsed
	}
	if parsed := parseJSONAny(row.ResponseElements); parsed != nil {
		payload["responseElements"] = parsed
	}
	if strings.TrimSpace(row.PrincipalArn) != "" || strings.TrimSpace(row.PrincipalType) != "" {
		payload["userIdentity"] = map[string]any{
			"type":        row.PrincipalType,
			"arn":         row.PrincipalArn,
			"accountId":   row.PrincipalAccountID,
			"userName":    row.PrincipalUserName,
			"accessKeyId": row.PrincipalAccessKeyID,
		}
	}
	bytes, _ := json.Marshal(payload)
	return json.RawMessage(bytes)
}

func parseJSONAny(raw string) any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return trimmed
	}
	return value
}

func parseOptionalBoolValue(value string) any {
	if parsed := parseOptionalBool(value); parsed != nil {
		return *parsed
	}
	return nil
}

func extractResourceFromRequest(eventName, eventSource, requestParameters, responseElements string) (string, string) {
	request := parseJSONObject(requestParameters)
	response := parseJSONObject(responseElements)
	eventNameLower := strings.ToLower(strings.TrimSpace(eventName))
	eventSourceLower := strings.ToLower(strings.TrimSpace(eventSource))
	resourceType := inferResourceTypeFromRequest(eventName, eventSource, requestParameters, responseElements)

	if resourceType == "ec2-instance" {
		resourceID := firstNonEmpty(
			deepStringValue(request, "instanceId"),
			deepStringValue(response, "instanceId"),
			deepStringValue(request, "instancesSet", "instanceId"),
			deepStringValue(response, "instancesSet", "instanceId"),
		)
		return resourceID, resourceID
	}

	if resourceType == "security-group" {
		resourceID := firstNonEmpty(
			stringValue(request, "groupId"),
			stringValue(response, "groupId"),
			deepStringValue(request, "groupId"),
			deepStringValue(response, "groupId"),
			findFilterValue(request, "group-id"),
			stringValue(request, "groupName"),
		)
		resourceName := firstNonEmpty(
			stringValue(request, "groupName"),
			findFilterValue(request, "group-name"),
		)
		return resourceID, resourceName
	}

	if strings.HasPrefix(resourceType, "iam-") {
		return extractIAMResource(resourceType, request, response)
	}

	resourceID := firstNonEmpty(
		stringValue(request, "groupId"),
		stringValue(response, "groupId"),
		stringValue(request, "groupRuleId"),
		stringValue(response, "groupRuleId"),
		stringValue(request, "securityGroupRuleId"),
		stringValue(response, "securityGroupRuleId"),
		findFilterValue(request, "group-id"),
		findFilterValue(request, "ip-permission.group-id"),
		findFilterValue(request, "egress.ip-permission.group-id"),
		findFilterValue(request, "security-group-rule-id"),
		findFilterValue(request, "network-interface-id"),
		findFilterValue(request, "subnet-id"),
		findFilterValue(request, "vpc-id"),
		findFilterValue(request, "prefix-list-id"),
		stringValue(request, "roleArn"),
		stringValue(request, "roleName"),
		stringValue(response, "assumedRoleUser.arn"),
		stringValue(request, "vpcId"),
		stringValue(response, "vpcId"),
		stringValue(response, "networkInterface.networkInterfaceId"),
		stringValue(response, "networkInterfaceId"),
		stringValue(request, "networkInterfaceId"),
		stringValue(request, "allocationId"),
		stringValue(response, "allocationId"),
		stringValue(request, "publicIp"),
		stringValue(response, "publicIp"),
		stringValue(request, "groupId"),
		stringValue(response, "groupId"),
		stringValue(request, "instanceId"),
		stringValue(response, "instanceId"),
		stringValue(request, "subnetId"),
		stringValue(response, "subnetId"),
		stringValue(request, "bucketName"),
		stringValue(request, "roleName"),
		stringValue(request, "userName"),
	)

	resourceName := firstNonEmpty(
		stringValue(request, "groupName"),
		findFilterValue(request, "group-name"),
		stringValue(request, "roleSessionName"),
		stringValue(request, "groupName"),
		stringValue(request, "bucketName"),
		stringValue(request, "roleName"),
		stringValue(request, "userName"),
	)

	if resourceID == "" && strings.Contains(eventNameLower, "securitygroup") {
		resourceID = firstNonEmpty(stringValue(request, "groupName"), stringValue(response, "groupName"))
	}
	if resourceID == "" && eventSourceLower == "sts.amazonaws.com" && eventNameLower == "assumerole" {
		resourceID = firstNonEmpty(stringValue(request, "roleArn"), stringValue(response, "assumedRoleUser.arn"))
	}

	return resourceID, resourceName
}

func inferResourceTypeFromRequest(eventName, eventSource, requestParameters, responseElements string) string {
	request := parseJSONObject(requestParameters)
	response := parseJSONObject(responseElements)
	eventNameLower := strings.ToLower(strings.TrimSpace(eventName))
	eventSourceLower := strings.ToLower(strings.TrimSpace(eventSource))

	switch {
	case eventSourceLower == "ec2.amazonaws.com" && allowedEC2InstanceEvents[strings.TrimSpace(eventName)]:
		return "ec2-instance"
	case eventSourceLower == "ec2.amazonaws.com" && allowedSecurityGroupEvents[strings.TrimSpace(eventName)]:
		return "security-group"
	case eventSourceLower == "iam.amazonaws.com":
		return inferIAMResourceType(request, response, eventNameLower)
	case eventSourceLower == "sts.amazonaws.com" && eventNameLower == "assumerole":
		return "iam-role"
	case strings.Contains(eventNameLower, "securitygroup") || firstNonEmpty(
		stringValue(request, "groupId"),
		stringValue(response, "groupId"),
		findFilterValue(request, "group-id"),
		findFilterValue(request, "ip-permission.group-id"),
		findFilterValue(request, "egress.ip-permission.group-id"),
	) != "":
		return "security-group"
	case strings.Contains(eventNameLower, "securitygrouprules") || strings.Contains(eventNameLower, "securitygrouprule") || firstNonEmpty(
		stringValue(request, "groupRuleId"),
		stringValue(response, "groupRuleId"),
		stringValue(request, "securityGroupRuleId"),
		stringValue(response, "securityGroupRuleId"),
		findFilterValue(request, "security-group-rule-id"),
	) != "":
		return "security-group-rule"
	case strings.Contains(eventNameLower, "networkinterface") || firstNonEmpty(
		stringValue(response, "networkInterface.networkInterfaceId"),
		stringValue(response, "networkInterfaceId"),
		stringValue(request, "networkInterfaceId"),
		findFilterValue(request, "network-interface-id"),
	) != "":
		return "network-interface"
	case strings.Contains(eventNameLower, "address") || firstNonEmpty(
		stringValue(request, "allocationId"),
		stringValue(response, "allocationId"),
		stringValue(request, "publicIp"),
		stringValue(response, "publicIp"),
	) != "":
		return "elastic-ip"
	case strings.Contains(eventNameLower, "vpc") || firstNonEmpty(
		stringValue(request, "vpcId"),
		stringValue(response, "vpcId"),
		findFilterValue(request, "vpc-id"),
	) != "":
		return "vpc"
	case strings.Contains(eventNameLower, "subnet") || firstNonEmpty(
		stringValue(request, "subnetId"),
		stringValue(response, "subnetId"),
		findFilterValue(request, "subnet-id"),
	) != "":
		return "subnet"
	case strings.Contains(eventNameLower, "instance") || firstNonEmpty(
		stringValue(request, "instanceId"),
		stringValue(response, "instanceId"),
	) != "":
		return "ec2-instance"
	case strings.Contains(eventNameLower, "prefixlist") || firstNonEmpty(
		stringValue(request, "prefixListId"),
		stringValue(response, "prefixListId"),
		findFilterValue(request, "prefix-list-id"),
	) != "":
		return "managed-prefix-list"
	case firstNonEmpty(stringValue(request, "bucketName"), stringValue(response, "bucketName")) != "":
		return "s3-bucket"
	case firstNonEmpty(stringValue(request, "roleArn"), stringValue(request, "roleName")) != "":
		return "iam-role"
	default:
		return ""
	}
}

func inferIAMResourceType(request, response map[string]any, eventNameLower string) string {
	switch {
	case firstNonEmpty(
		stringValue(request, "accessKeyId"),
		deepStringValue(response, "accessKeyId"),
	) != "" || strings.Contains(eventNameLower, "accesskey"):
		return "iam-access-key"
	case firstNonEmpty(
		stringValue(request, "roleArn"),
		stringValue(request, "roleName"),
		deepStringValue(response, "roleName"),
		stringValue(response, "assumedRoleUser.arn"),
	) != "" || strings.Contains(eventNameLower, "role"):
		return "iam-role"
	case firstNonEmpty(
		stringValue(request, "policyArn"),
		stringValue(request, "policyName"),
		deepStringValue(response, "policyArn"),
	) != "" || strings.Contains(eventNameLower, "policy"):
		return "iam-policy"
	case firstNonEmpty(
		stringValue(request, "groupName"),
		deepStringValue(response, "groupName"),
	) != "" || strings.Contains(eventNameLower, "group"):
		return "iam-group"
	case firstNonEmpty(
		stringValue(request, "instanceProfileName"),
		stringValue(request, "instanceProfileArn"),
		deepStringValue(response, "instanceProfileName"),
	) != "" || strings.Contains(eventNameLower, "instanceprofile"):
		return "iam-instance-profile"
	case firstNonEmpty(
		stringValue(request, "userName"),
		deepStringValue(response, "userName"),
	) != "" || strings.Contains(eventNameLower, "user"):
		return "iam-user"
	default:
		return "iam-entity"
	}
}

func extractIAMResource(resourceType string, request, response map[string]any) (string, string) {
	switch resourceType {
	case "iam-access-key":
		resourceID := firstNonEmpty(stringValue(request, "accessKeyId"), deepStringValue(response, "accessKeyId"))
		return resourceID, resourceID
	case "iam-role":
		resourceID := firstNonEmpty(stringValue(request, "roleArn"), stringValue(response, "assumedRoleUser.arn"), stringValue(request, "roleName"), deepStringValue(response, "roleName"))
		resourceName := firstNonEmpty(stringValue(request, "roleName"), deepStringValue(response, "roleName"), stringValue(request, "roleSessionName"))
		return resourceID, resourceName
	case "iam-policy":
		resourceID := firstNonEmpty(stringValue(request, "policyArn"), deepStringValue(response, "policyArn"), stringValue(request, "policyName"))
		resourceName := firstNonEmpty(stringValue(request, "policyName"), deepStringValue(response, "policyName"))
		return resourceID, resourceName
	case "iam-group":
		resourceID := firstNonEmpty(stringValue(request, "groupName"), deepStringValue(response, "groupName"))
		return resourceID, resourceID
	case "iam-instance-profile":
		resourceID := firstNonEmpty(stringValue(request, "instanceProfileArn"), stringValue(request, "instanceProfileName"), deepStringValue(response, "instanceProfileArn"), deepStringValue(response, "instanceProfileName"))
		resourceName := firstNonEmpty(stringValue(request, "instanceProfileName"), deepStringValue(response, "instanceProfileName"))
		return resourceID, resourceName
	case "iam-user":
		resourceID := firstNonEmpty(stringValue(request, "userName"), deepStringValue(response, "userName"))
		return resourceID, resourceID
	default:
		resourceID := firstNonEmpty(
			stringValue(request, "userName"),
			stringValue(request, "roleArn"),
			stringValue(request, "roleName"),
			stringValue(request, "policyArn"),
			stringValue(request, "groupName"),
			stringValue(request, "instanceProfileName"),
			stringValue(request, "accessKeyId"),
		)
		return resourceID, resourceID
	}
}

func parseJSONObject(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil {
		return nil
	}
	return decoded
}

func stringValue(data map[string]any, path string) string {
	if data == nil {
		return ""
	}
	parts := strings.Split(path, ".")
	var current any = data
	for _, part := range parts {
		obj, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = obj[part]
	}
	switch value := current.(type) {
	case string:
		return value
	default:
		return ""
	}
}

func findFilterValue(data map[string]any, filterName string) string {
	itemsAny := nestedValue(data, "filterSet.items")
	items, ok := itemsAny.([]any)
	if !ok {
		return ""
	}
	for _, itemAny := range items {
		item, ok := itemAny.(map[string]any)
		if !ok {
			continue
		}
		name, _ := item["name"].(string)
		if strings.TrimSpace(name) != filterName {
			continue
		}
		valueItemsAny := nestedValue(item, "valueSet.items")
		valueItems, ok := valueItemsAny.([]any)
		if !ok || len(valueItems) == 0 {
			continue
		}
		if first, ok := valueItems[0].(map[string]any); ok {
			if value, ok := first["value"].(string); ok {
				return value
			}
		}
	}
	return ""
}

func nestedValue(data map[string]any, path string) any {
	if data == nil {
		return nil
	}
	parts := strings.Split(path, ".")
	var current any = data
	for _, part := range parts {
		obj, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = obj[part]
	}
	return current
}

func deepStringValue(data map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := deepFindString(data, key); value != "" {
			return value
		}
	}
	return ""
}

func deepFindString(value any, targetKey string) string {
	switch typed := value.(type) {
	case map[string]any:
		if direct, ok := typed[targetKey]; ok {
			switch v := direct.(type) {
			case string:
				if strings.TrimSpace(v) != "" {
					return v
				}
			}
		}
		for _, child := range typed {
			if result := deepFindString(child, targetKey); result != "" {
				return result
			}
		}
	case []any:
		for _, child := range typed {
			if result := deepFindString(child, targetKey); result != "" {
				return result
			}
		}
	}
	return ""
}

func sortedAllowedEventNames(values map[string]bool) []string {
	result := make([]string, 0, len(values))
	for name, enabled := range values {
		if enabled {
			result = append(result, name)
		}
	}
	sort.Strings(result)
	return result
}

func quoteSQLList(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, fmt.Sprintf("'%s'", escapeSQLString(value)))
	}
	return strings.Join(quoted, ", ")
}

func looksLikeARN(value string) bool {
	return strings.HasPrefix(strings.TrimSpace(value), "arn:")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func sanitizeIdentifier(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "soc_logs"
	}
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			return r
		}
		return -1
	}, trimmed)
}

func escapeSQLString(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

func sleepWithContext(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func int32Ptr(value int32) *int32 {
	return &value
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
	return envIntFromString(value, fallback)
}

func envIntFromString(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func normalizeSourceMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "s3":
		return "s3"
	case "sqs", "":
		return "sqs"
	default:
		return "sqs"
	}
}

func clamp(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func nonZeroTime(value time.Time) time.Time {
	if value.IsZero() {
		return time.Now().UTC()
	}
	return value
}

func jsonOrNull(value json.RawMessage) any {
	trimmed := strings.TrimSpace(string(value))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	return trimmed
}
