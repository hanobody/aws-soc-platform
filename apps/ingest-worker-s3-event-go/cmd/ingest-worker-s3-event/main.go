package main

import (
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
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

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultAWSRegion                = "ap-southeast-1"
	defaultObjectCreatedQueueURL    = "https://sqs.ap-southeast-1.amazonaws.com/809893975949/cloudtrail-object-created-queue"
	defaultDatabaseURL              = "postgresql://soc_admin:soc_dev_password@localhost:5433/soc_platform"
	defaultS3EventVisibilitySeconds = 300
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
	"CreateSecurityGroup":                        true,
	"DeleteSecurityGroup":                        true,
	"AuthorizeSecurityGroupIngress":              true,
	"RevokeSecurityGroupIngress":                 true,
	"AuthorizeSecurityGroupEgress":               true,
	"RevokeSecurityGroupEgress":                  true,
	"ModifySecurityGroupRules":                   true,
	"UpdateSecurityGroupRuleDescriptionsIngress": true,
	"UpdateSecurityGroupRuleDescriptionsEgress":  true,
}

var allowedSTSRoleEvents = map[string]bool{
	"AssumeRole":                true,
	"AssumeRoleWithSAML":        true,
	"AssumeRoleWithWebIdentity": true,
}

var defaultIngestEventRules = []IngestEventRule{
	{EventSource: "iam.amazonaws.com", EventNames: []string{"*"}},
	{EventSource: "sts.amazonaws.com", EventNames: []string{"AssumeRole", "AssumeRoleWithSAML", "AssumeRoleWithWebIdentity"}},
	{EventSource: "ec2.amazonaws.com", EventNames: []string{"RunInstances", "StartInstances", "StopInstances", "RebootInstances", "TerminateInstances", "ModifyInstanceAttribute", "MonitorInstances", "UnmonitorInstances", "CreateSecurityGroup", "DeleteSecurityGroup", "AuthorizeSecurityGroupIngress", "RevokeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupEgress", "ModifySecurityGroupRules", "UpdateSecurityGroupRuleDescriptionsIngress", "UpdateSecurityGroupRuleDescriptionsEgress"}},
}

type Consumer struct {
	sqsClient      *sqs.Client
	s3Client       *s3.Client
	db             *pgxpool.Pool
	workerName     string
	messageWorkers int
	objectWorkers  int
	matchWorkers   int
	configMu       sync.RWMutex
	config         RuntimeConfig
}

type RuntimeConfig struct {
	Enabled    bool
	QueueURL   string
	BatchSize  int32
	WaitTime   int32
	Visibility int32
	Targets    []TargetScope
	EventRules []IngestEventRule
}

type IngestEventRule struct {
	EventSource string   `json:"eventSource"`
	EventNames  []string `json:"eventNames"`
}

type TargetScope struct {
	AccountID string   `json:"accountId"`
	Regions   []string `json:"regions"`
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

type s3EventMessage struct {
	Records []struct {
		EventSource string `json:"eventSource"`
		EventName   string `json:"eventName"`
		S3          struct {
			Bucket struct {
				Name string `json:"name"`
			} `json:"bucket"`
			Object struct {
				Key string `json:"key"`
			} `json:"object"`
		} `json:"s3"`
	} `json:"Records"`
}

type cloudTrailLogFile struct {
	Records []json.RawMessage `json:"Records"`
}

type cloudTrailRecord struct {
	EventID            string          `json:"eventID"`
	EventTime          string          `json:"eventTime"`
	EventSource        string          `json:"eventSource"`
	EventName          string          `json:"eventName"`
	EventType          string          `json:"eventType"`
	EventCategory      string          `json:"eventCategory"`
	ReadOnly           any             `json:"readOnly"`
	RecipientAccountID string          `json:"recipientAccountId"`
	AWSRegion          string          `json:"awsRegion"`
	SourceIPAddress    string          `json:"sourceIPAddress"`
	UserAgent          string          `json:"userAgent"`
	RequestID          string          `json:"requestID"`
	RequestParameters  json.RawMessage `json:"requestParameters"`
	ResponseElements   json.RawMessage `json:"responseElements"`
	UserIdentity       struct {
		Type        string `json:"type"`
		ARN         string `json:"arn"`
		AccountID   string `json:"accountId"`
		UserName    string `json:"userName"`
		AccessKeyID string `json:"accessKeyId"`
	} `json:"userIdentity"`
	Resources []struct {
		ARN       string `json:"ARN"`
		AccountID string `json:"accountId"`
		Type      string `json:"type"`
	} `json:"resources"`
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

type NotificationChannel struct {
	ID          int64
	ChannelName string
	ChannelType string
	BotToken    string
	ChatID      string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	region := envOrDefault("AWS_REGION", defaultAWSRegion)
	queueURL := envOrDefault("S3_OBJECT_CREATED_QUEUE_URL", defaultObjectCreatedQueueURL)
	databaseURL := envOrDefault("DATABASE_URL", defaultDatabaseURL)
	batchSize := int32(envInt("S3_EVENT_SQS_MAX_MESSAGES", 10))
	waitTime := int32(envInt("S3_EVENT_SQS_WAIT_SECONDS", 20))
	visibility := int32(envInt("S3_EVENT_SQS_VISIBILITY_TIMEOUT", defaultS3EventVisibilitySeconds))
	messageWorkers := clamp(envInt("S3_EVENT_MESSAGE_WORKERS", 4), 1, 32)
	objectWorkers := clamp(envInt("S3_EVENT_OBJECT_WORKERS", 4), 1, 32)
	matchWorkers := clamp(envInt("S3_EVENT_MATCH_WORKERS", 8), 1, 64)

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
		sqsClient:      sqs.NewFromConfig(awsCfg),
		s3Client:       s3.NewFromConfig(awsCfg),
		db:             db,
		workerName:     envOrDefault("WORKER_NAME", "ingest-worker-s3-event"),
		messageWorkers: messageWorkers,
		objectWorkers:  objectWorkers,
		matchWorkers:   matchWorkers,
		config: RuntimeConfig{
			Enabled:    true,
			QueueURL:   queueURL,
			BatchSize:  int32(clamp(int(batchSize), 1, 10)),
			WaitTime:   int32(clamp(int(waitTime), 0, 20)),
			Visibility: int32(clamp(int(visibility), 0, 43200)),
			EventRules: cloneEventRules(defaultIngestEventRules),
		},
	}

	if err := consumer.ensureWorkerStatusTable(ctx); err != nil {
		log.Fatalf("ensure worker status table: %v", err)
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

	log.Printf("s3 event ingest worker started queue=%s region=%s enabled=%t", startupConfig.QueueURL, region, startupConfig.Enabled)
	if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("consumer stopped with error: %v", err)
	}
	log.Printf("s3 event ingest worker stopped")
}

func startupMessage(cfg RuntimeConfig, region string) string {
	return fmt.Sprintf("enabled=%t queue=%s batch=%d wait=%d visibility=%d targets=%d region=%s", cfg.Enabled, cfg.QueueURL, cfg.BatchSize, cfg.WaitTime, cfg.Visibility, len(cfg.Targets), region)
}

func (c *Consumer) Run(ctx context.Context) error {
	reloadTicker := time.NewTicker(10 * time.Second)
	defer reloadTicker.Stop()

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
		if !cfg.Enabled {
			message := fmt.Sprintf("paused queue=%s targets=%d", cfg.QueueURL, len(cfg.Targets))
			_ = c.updateWorkerStatus(ctx, "paused", message)
			sleepWithContext(ctx, 3*time.Second)
			continue
		}

		status, message, err := c.runOnce(ctx, cfg)
		if err != nil {
			_ = c.updateWorkerStatus(ctx, status, message)
			return err
		}
		_ = c.updateWorkerStatus(ctx, status, message)
	}
}

func (c *Consumer) runOnce(ctx context.Context, cfg RuntimeConfig) (string, string, error) {
	statusMessage := fmt.Sprintf("polling S3 object-created queue=%s batch=%d wait=%d visibility=%d targets=%d msgWorkers=%d objWorkers=%d matchWorkers=%d", cfg.QueueURL, cfg.BatchSize, cfg.WaitTime, cfg.Visibility, len(cfg.Targets), c.messageWorkers, c.objectWorkers, c.matchWorkers)
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

	type messageResult struct {
		objects  int
		inserted int
		err      error
	}
	sem := make(chan struct{}, c.messageWorkers)
	results := make(chan messageResult, len(resp.Messages))
	var wg sync.WaitGroup
	for _, msg := range resp.Messages {
		wg.Add(1)
		sem <- struct{}{}
		go func(msg types.Message) {
			defer wg.Done()
			defer func() { <-sem }()
			objects, inserted, err := c.handleMessage(ctx, msg, cfg)
			results <- messageResult{objects: objects, inserted: inserted, err: err}
		}(msg)
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	processedMessages := 0
	processedObjects := 0
	insertedEvents := 0
	for result := range results {
		if result.err != nil {
			log.Printf("handle message failed err=%v", result.err)
			continue
		}
		processedMessages++
		processedObjects += result.objects
		insertedEvents += result.inserted
	}

	return "running", fmt.Sprintf("processed messages=%d objects=%d inserted=%d", processedMessages, processedObjects, insertedEvents), nil
}

func (c *Consumer) handleMessage(ctx context.Context, msg types.Message, cfg RuntimeConfig) (int, int, error) {
	body, err := unwrapS3EventMessage(deref(msg.Body))
	if err != nil {
		return 0, 0, err
	}

	var event s3EventMessage
	if err := json.Unmarshal([]byte(body), &event); err != nil {
		return 0, 0, fmt.Errorf("unmarshal s3 event body: %w", err)
	}

	type objectRef struct {
		bucket string
		key    string
	}
	objects := make([]objectRef, 0, len(event.Records))
	for _, record := range event.Records {
		if strings.TrimSpace(record.EventSource) != "aws:s3" {
			continue
		}
		bucket := strings.TrimSpace(record.S3.Bucket.Name)
		key := decodeS3ObjectKey(record.S3.Object.Key)
		if bucket == "" || key == "" {
			continue
		}
		if !shouldProcessCloudTrailObjectKey(key) {
			log.Printf("skip non-cloudtrail object bucket=%s key=%s", bucket, key)
			continue
		}
		objects = append(objects, objectRef{bucket: bucket, key: key})
	}

	type objectResult struct {
		inserted int
		err      error
	}
	processedObjects := len(objects)
	insertedEvents := 0
	results := make(chan objectResult, len(objects))
	sem := make(chan struct{}, c.objectWorkers)
	var wg sync.WaitGroup
	for _, obj := range objects {
		wg.Add(1)
		sem <- struct{}{}
		go func(obj objectRef) {
			defer wg.Done()
			defer func() { <-sem }()
			inserted, err := c.processObject(ctx, obj.bucket, obj.key, cfg)
			if err != nil {
				results <- objectResult{err: fmt.Errorf("process s3 object %s/%s: %w", obj.bucket, obj.key, err)}
				return
			}
			results <- objectResult{inserted: inserted}
		}(obj)
	}
	go func() {
		wg.Wait()
		close(results)
	}()
	for result := range results {
		if result.err != nil {
			return processedObjects, insertedEvents, result.err
		}
		insertedEvents += result.inserted
	}

	_, err = c.sqsClient.DeleteMessage(ctx, &sqs.DeleteMessageInput{
		QueueUrl:      &cfg.QueueURL,
		ReceiptHandle: msg.ReceiptHandle,
	})
	if err != nil {
		return processedObjects, insertedEvents, fmt.Errorf("delete sqs message: %w", err)
	}

	return processedObjects, insertedEvents, nil
}

func (c *Consumer) processObject(ctx context.Context, bucket, key string, cfg RuntimeConfig) (int, error) {
	resp, err := c.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &bucket,
		Key:    &key,
	})
	if err != nil {
		return 0, fmt.Errorf("get object: %w", err)
	}
	defer resp.Body.Close()

	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return 0, fmt.Errorf("create gzip reader: %w", err)
	}
	defer gz.Close()

	payload, err := io.ReadAll(gz)
	if err != nil {
		return 0, fmt.Errorf("read gzip body: %w", err)
	}

	var file cloudTrailLogFile
	if err := json.Unmarshal(payload, &file); err != nil {
		return 0, fmt.Errorf("unmarshal cloudtrail log file: %w", err)
	}

	type recordResult struct {
		inserted int
		err      error
	}
	inserted := 0
	recordJobs := make(chan json.RawMessage)
	results := make(chan recordResult, len(file.Records))
	var wg sync.WaitGroup
	workerCount := c.matchWorkers
	if workerCount > len(file.Records) && len(file.Records) > 0 {
		workerCount = len(file.Records)
	}
	if workerCount < 1 {
		workerCount = 1
	}
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for rawRecord := range recordJobs {
				envelope, ok, err := mapRawCloudTrailRecord(rawRecord, bucket, key, cfg)
				if err != nil {
					log.Printf("skip invalid cloudtrail record bucket=%s key=%s err=%v", bucket, key, err)
					results <- recordResult{}
					continue
				}
				if !ok || !shouldProcessTarget(cfg.Targets, envelope.AWS.AccountID, envelope.AWS.Region) {
					results <- recordResult{}
					continue
				}
				stored, err := c.matchAndHandleEvent(ctx, envelope)
				if err != nil {
					results <- recordResult{err: err}
					continue
				}
				if stored {
					results <- recordResult{inserted: 1}
					continue
				}
				results <- recordResult{}
			}
		}()
	}
	go func() {
		for _, rawRecord := range file.Records {
			recordJobs <- rawRecord
		}
		close(recordJobs)
		wg.Wait()
		close(results)
	}()
	for result := range results {
		if result.err != nil {
			return inserted, result.err
		}
		inserted += result.inserted
	}

	log.Printf("processed object bucket=%s key=%s records=%d inserted=%d", bucket, key, len(file.Records), inserted)
	return inserted, nil
}

func unwrapS3EventMessage(body string) (string, error) {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return "", fmt.Errorf("empty body")
	}

	var direct struct {
		Records []json.RawMessage `json:"Records"`
	}
	if err := json.Unmarshal([]byte(trimmed), &direct); err == nil && len(direct.Records) > 0 {
		return trimmed, nil
	}

	var wrapped struct {
		Message string `json:"Message"`
	}
	if err := json.Unmarshal([]byte(trimmed), &wrapped); err == nil && strings.TrimSpace(wrapped.Message) != "" {
		return wrapped.Message, nil
	}

	return "", fmt.Errorf("unsupported s3 event message format")
}

func mapRawCloudTrailRecord(rawRecord json.RawMessage, bucket, key string, cfg RuntimeConfig) (CloudTrailEnvelope, bool, error) {
	var record cloudTrailRecord
	if err := json.Unmarshal(rawRecord, &record); err != nil {
		return CloudTrailEnvelope{}, false, fmt.Errorf("unmarshal cloudtrail record: %w", err)
	}
	if strings.TrimSpace(record.EventID) == "" {
		return CloudTrailEnvelope{}, false, fmt.Errorf("missing eventID")
	}
	if !shouldIngestEvent(record.EventSource, record.EventName, cfg) {
		return CloudTrailEnvelope{}, false, nil
	}

	eventTime, err := time.Parse(time.RFC3339, strings.TrimSpace(record.EventTime))
	if err != nil {
		return CloudTrailEnvelope{}, false, fmt.Errorf("parse eventTime: %w", err)
	}

	var envelope CloudTrailEnvelope
	envelope.SchemaVersion = "cloudtrail.event.v1"
	envelope.EventID = record.EventID
	envelope.DedupKey = fmt.Sprintf("cloudtrail:%s:%s:%s", nonEmpty(record.RecipientAccountID, "unknown"), nonEmpty(record.AWSRegion, "unknown"), record.EventID)
	envelope.IngestSource = fmt.Sprintf("s3.object-created:%s", bucket)
	envelope.IngestTime = time.Now().UTC()
	envelope.AWS.AccountID = record.RecipientAccountID
	envelope.AWS.Region = record.AWSRegion
	envelope.AWS.Partition = inferPartition(record)
	envelope.Event.Source = "aws.cloudtrail"
	envelope.Event.DetailType = nonEmpty(record.EventType, "AWS API Call via CloudTrail")
	envelope.Event.EventSource = record.EventSource
	envelope.Event.EventName = record.EventName
	envelope.Event.EventTime = eventTime.UTC()
	envelope.Event.EventCategory = nonEmpty(record.EventCategory, "Management")
	envelope.Event.ReadOnly = parseCloudTrailReadOnly(record.ReadOnly)
	envelope.Actor.PrincipalType = record.UserIdentity.Type
	envelope.Actor.ARN = record.UserIdentity.ARN
	envelope.Actor.AccountID = record.UserIdentity.AccountID
	envelope.Actor.UserName = record.UserIdentity.UserName
	envelope.Actor.AccessKeyID = record.UserIdentity.AccessKeyID
	envelope.Network.SourceIP = record.SourceIPAddress
	envelope.Network.UserAgent = record.UserAgent
	envelope.Request.RequestID = record.RequestID
	envelope.Request.RequestParameters = normalizeRawJSON(record.RequestParameters)
	envelope.Request.ResponseElements = normalizeRawJSON(record.ResponseElements)
	envelope.RawEvent = rawRecord

	requestParameters := rawMessageString(envelope.Request.RequestParameters)
	responseElements := rawMessageString(envelope.Request.ResponseElements)
	envelope.Resource.ResourceType = inferResourceTypeFromRequest(record.EventName, record.EventSource, requestParameters, responseElements)
	envelope.Resource.ResourceID, envelope.Resource.ResourceName = extractResourceFromRequest(record.EventName, record.EventSource, requestParameters, responseElements)
	envelope.Resource.ResourceARN = inferResourceARN(record, envelope.Resource.ResourceID)
	normalizeScopedEnvelope(&envelope, cfg)

	return envelope, true, nil
}

func inferPartition(record cloudTrailRecord) string {
	for _, arn := range []string{record.UserIdentity.ARN} {
		if value := partitionFromARN(arn); value != "" {
			return value
		}
	}
	for _, resource := range record.Resources {
		if value := partitionFromARN(resource.ARN); value != "" {
			return value
		}
	}
	return "aws"
}

func inferResourceARN(record cloudTrailRecord, resourceID string) string {
	if looksLikeARN(resourceID) {
		return resourceID
	}
	for _, resource := range record.Resources {
		if strings.TrimSpace(resource.ARN) != "" {
			return resource.ARN
		}
	}
	return ""
}

func partitionFromARN(arn string) string {
	parts := strings.Split(strings.TrimSpace(arn), ":")
	if len(parts) >= 2 && parts[0] == "arn" && strings.TrimSpace(parts[1]) != "" {
		return parts[1]
	}
	return ""
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
			if !cfg.Enabled {
				status = "paused"
			}
			_ = c.updateWorkerStatus(context.Background(), status, fmt.Sprintf("heartbeat queue=%s targets=%d", cfg.QueueURL, len(cfg.Targets)))
		}
	}
}

func (c *Consumer) getRuntimeConfig() RuntimeConfig {
	c.configMu.RLock()
	defer c.configMu.RUnlock()
	return cloneRuntimeConfig(c.config)
}

func (c *Consumer) setRuntimeConfig(cfg RuntimeConfig) {
	c.configMu.Lock()
	defer c.configMu.Unlock()
	c.config = cloneRuntimeConfig(cfg)
}

func (c *Consumer) reloadRuntimeConfig(ctx context.Context) error {
	current := c.getRuntimeConfig()
	legacyRules := c.legacyEventRulesFallback(ctx, current.EventRules)
	cfg := RuntimeConfig{
		Enabled:    c.getBoolSetting(ctx, "ingest.enabled", current.Enabled),
		QueueURL:   c.getStringSetting(ctx, "ingest.queueUrl", current.QueueURL),
		BatchSize:  int32(clamp(c.getIntSetting(ctx, "ingest.maxMessages", int(current.BatchSize)), 1, 10)),
		WaitTime:   int32(clamp(c.getIntSetting(ctx, "ingest.waitSeconds", int(current.WaitTime)), 0, 20)),
		Visibility: int32(clamp(c.getIntSetting(ctx, "ingest.visibilityTimeout", int(current.Visibility)), 0, 43200)),
		Targets:    c.getJSONSettingTargets(ctx, "ingest.targets", current.Targets),
		EventRules: c.getJSONSettingEventRules(ctx, "ingest.eventRules", legacyRules),
	}
	if strings.TrimSpace(cfg.QueueURL) == "" {
		cfg.QueueURL = current.QueueURL
	}
	if len(cfg.EventRules) == 0 {
		cfg.EventRules = cloneEventRules(defaultIngestEventRules)
	}
	c.setRuntimeConfig(cfg)
	return nil
}

func (c *Consumer) getStringSetting(ctx context.Context, key, fallback string) string {
	var value *string
	err := c.db.QueryRow(ctx, `SELECT setting_value FROM app_settings WHERE setting_key = $1`, key).Scan(&value)
	if err != nil || value == nil || strings.TrimSpace(*value) == "" {
		return fallback
	}
	return strings.TrimSpace(*value)
}

func (c *Consumer) getBoolSetting(ctx context.Context, key string, fallback bool) bool {
	value := strings.ToLower(c.getStringSetting(ctx, key, strconv.FormatBool(fallback)))
	switch value {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		return fallback
	}
}

func (c *Consumer) getIntSetting(ctx context.Context, key string, fallback int) int {
	return envIntFromString(c.getStringSetting(ctx, key, strconv.Itoa(fallback)), fallback)
}

func (c *Consumer) getJSONStringArray(ctx context.Context, key string, fallback map[string]bool) []string {
	raw := c.getStringSetting(ctx, key, "")
	if strings.TrimSpace(raw) == "" {
		return enabledKeys(fallback)
	}
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return enabledKeys(fallback)
	}
	return values
}

func (c *Consumer) getJSONSettingTargets(ctx context.Context, key string, fallback []TargetScope) []TargetScope {
	raw := c.getStringSetting(ctx, key, "")
	if strings.TrimSpace(raw) == "" {
		return cloneTargets(fallback)
	}
	var values []TargetScope
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return cloneTargets(fallback)
	}
	return normalizeTargets(values)
}

func (c *Consumer) getJSONSettingEventRules(ctx context.Context, key string, fallback []IngestEventRule) []IngestEventRule {
	raw := c.getStringSetting(ctx, key, "")
	if strings.TrimSpace(raw) == "" {
		return cloneEventRules(fallback)
	}
	var values []IngestEventRule
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return cloneEventRules(fallback)
	}
	return normalizeEventRules(values)
}

func (c *Consumer) legacyEventRulesFallback(ctx context.Context, fallback []IngestEventRule) []IngestEventRule {
	iamCaptureAll := c.getBoolSetting(ctx, "ingest.iam.captureAll", false)
	stsEvents := normalizeEventMap(c.getJSONStringArray(ctx, "ingest.sts.events", map[string]bool{}), allowedSTSRoleEvents)
	ec2InstanceEvents := normalizeEventMap(c.getJSONStringArray(ctx, "ingest.ec2.instanceEvents", map[string]bool{}), allowedEC2InstanceEvents)
	ec2SecurityGroupEvents := normalizeEventMap(c.getJSONStringArray(ctx, "ingest.ec2.securityGroupEvents", map[string]bool{}), allowedSecurityGroupEvents)
	rules := make([]IngestEventRule, 0, 3)
	if iamCaptureAll {
		rules = append(rules, IngestEventRule{EventSource: "iam.amazonaws.com", EventNames: []string{"*"}})
	}
	if len(stsEvents) > 0 {
		rules = append(rules, IngestEventRule{EventSource: "sts.amazonaws.com", EventNames: enabledKeys(stsEvents)})
	}
	ec2Events := map[string]bool{}
	for key, value := range ec2InstanceEvents {
		ec2Events[key] = value
	}
	for key, value := range ec2SecurityGroupEvents {
		ec2Events[key] = value
	}
	if len(ec2Events) > 0 {
		rules = append(rules, IngestEventRule{EventSource: "ec2.amazonaws.com", EventNames: enabledKeys(ec2Events)})
	}
	if len(rules) == 0 {
		return cloneEventRules(fallback)
	}
	return normalizeEventRules(rules)
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

func (c *Consumer) updateWorkerStatus(ctx context.Context, status, message string) error {
	const q = `
INSERT INTO worker_status (worker_name, worker_type, status, last_heartbeat_at, last_message, updated_at)
VALUES ($1, 'ingest-worker-s3-event', $2, NOW(), $3, NOW())
ON CONFLICT (worker_name) DO UPDATE
SET status = EXCLUDED.status,
    last_heartbeat_at = EXCLUDED.last_heartbeat_at,
    last_message = EXCLUDED.last_message,
    updated_at = EXCLUDED.updated_at`
	_, err := c.db.Exec(ctx, q, c.workerName, status, nullIfEmpty(message))
	return err
}

func (c *Consumer) matchAndHandleEvent(ctx context.Context, e CloudTrailEnvelope) (bool, error) {
	rules, err := c.loadCandidateRules(ctx, e)
	if err != nil {
		return false, fmt.Errorf("load candidate rules: %w", err)
	}
	matched := make([]Rule, 0, len(rules))
	for _, rule := range rules {
		if ruleMatches(rule, e) {
			matched = append(matched, rule)
		}
	}
	if len(matched) == 0 {
		return false, nil
	}
	sort.Slice(matched, func(i, j int) bool {
		return ruleSpecificity(matched[i]) > ruleSpecificity(matched[j])
	})
	rule := matched[0]

	if rule.CooldownSeconds > 0 {
		cooldownHit, err := c.isCooldownHit(ctx, e, rule)
		if err != nil {
			return false, fmt.Errorf("check cooldown: %w", err)
		}
		if cooldownHit {
			return false, nil
		}
	}

	alertEventID, channel, inserted, err := c.insertAlertEvent(ctx, e, rule)
	if err != nil {
		return false, fmt.Errorf("insert alert event: %w", err)
	}
	if !inserted {
		return false, nil
	}
	if channel == nil {
		if err := c.updateAlertNotificationStatus(ctx, alertEventID, nil, "pending", nil, "no_notification_channel"); err != nil {
			return true, fmt.Errorf("mark alert pending: %w", err)
		}
		return true, nil
	}
	if err := sendNotification(*channel, e, rule); err != nil {
		if updateErr := c.updateAlertNotificationStatus(ctx, alertEventID, &channel.ID, "notify_failed", nil, err.Error()); updateErr != nil {
			return true, fmt.Errorf("notify alert failed: %v; update status failed: %w", err, updateErr)
		}
		log.Printf("notification failed event_id=%s rule_id=%d err=%v", e.EventID, rule.ID, err)
		return true, nil
	}
	if err := c.updateAlertNotificationStatus(ctx, alertEventID, &channel.ID, "sent", timePtr(time.Now().UTC()), nil); err != nil {
		return true, fmt.Errorf("update alert status sent: %w", err)
	}
	return true, nil
}

func shouldIngestEvent(eventSource, eventName string, cfg RuntimeConfig) bool {
	source := strings.ToLower(strings.TrimSpace(eventSource))
	name := strings.TrimSpace(eventName)
	for _, rule := range cfg.EventRules {
		if !strings.EqualFold(strings.TrimSpace(rule.EventSource), source) && !strings.EqualFold(strings.TrimSpace(rule.EventSource), eventSource) {
			continue
		}
		for _, candidate := range rule.EventNames {
			candidate = strings.TrimSpace(candidate)
			if candidate == "*" || strings.EqualFold(candidate, name) {
				return true
			}
		}
	}
	return false
}

func (c *Consumer) loadCandidateRules(ctx context.Context, e CloudTrailEnvelope) ([]Rule, error) {
	rows, err := c.db.Query(ctx, `
SELECT id, rule_name, account_id, region_code, event_source, event_name, resource_type,
       resource_pattern, user_arn_pattern, source_ip_pattern, severity, cooldown_seconds, notification_route_id
FROM alert_rules
WHERE enabled = TRUE
  AND account_id IN ($1, '*')
  AND event_source = $2
  AND event_name = $3
ORDER BY id ASC`, e.AWS.AccountID, e.Event.EventSource, e.Event.EventName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []Rule{}
	for rows.Next() {
		var rule Rule
		var regionCode, resourceType, resourcePattern, userArnPattern, sourceIPPattern, severity sql.NullString
		var notificationRouteID sql.NullInt64
		if err := rows.Scan(
			&rule.ID,
			&rule.RuleName,
			&rule.AccountID,
			&regionCode,
			&rule.EventSource,
			&rule.EventName,
			&resourceType,
			&resourcePattern,
			&userArnPattern,
			&sourceIPPattern,
			&severity,
			&rule.CooldownSeconds,
			&notificationRouteID,
		); err != nil {
			return nil, err
		}
		rule.RegionCode = regionCode.String
		rule.ResourceType = resourceType.String
		rule.ResourcePattern = resourcePattern.String
		rule.UserArnPattern = userArnPattern.String
		rule.SourceIPPattern = sourceIPPattern.String
		rule.Severity = severity.String
		if notificationRouteID.Valid {
			value := notificationRouteID.Int64
			rule.NotificationRouteID = &value
		}
		if rule.compiledResource, err = compileWildcardList(rule.ResourcePattern); err != nil {
			return nil, fmt.Errorf("compile resource pattern for rule %d: %w", rule.ID, err)
		}
		if rule.compiledUserArn, err = compileWildcardList(rule.UserArnPattern); err != nil {
			return nil, fmt.Errorf("compile user arn pattern for rule %d: %w", rule.ID, err)
		}
		if rule.compiledSourceIP, err = compileWildcardList(rule.SourceIPPattern); err != nil {
			return nil, fmt.Errorf("compile source ip pattern for rule %d: %w", rule.ID, err)
		}
		result = append(result, rule)
	}
	return result, rows.Err()
}

func ruleMatches(rule Rule, e CloudTrailEnvelope) bool {
	if !stringEquals(rule.RegionCode, e.AWS.Region) {
		return false
	}
	if !stringEquals(rule.ResourceType, e.Resource.ResourceType) {
		return false
	}
	if !matchCompiled(e.Resource.ResourceID, rule.compiledResource) && !matchCompiled(e.Resource.ResourceName, rule.compiledResource) {
		return false
	}
	if !matchCompiled(e.Actor.ARN, rule.compiledUserArn) {
		return false
	}
	if !matchCompiled(e.Network.SourceIP, rule.compiledSourceIP) {
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

func nonWildcard(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && value != "*"
}

func (c *Consumer) isCooldownHit(ctx context.Context, e CloudTrailEnvelope, rule Rule) (bool, error) {
	const q = `
SELECT 1
FROM alert_events
WHERE matched_rule_id = $1
  AND account_id = $2
  AND event_name = $3
  AND COALESCE(resource_id, '') = COALESCE($4, '')
  AND event_time >= $5
LIMIT 1`
	var exists int
	since := e.Event.EventTime.Add(-time.Duration(rule.CooldownSeconds) * time.Second)
	err := c.db.QueryRow(ctx, q, rule.ID, e.AWS.AccountID, e.Event.EventName, nullIfEmpty(e.Resource.ResourceID), since).Scan(&exists)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (c *Consumer) insertAlertEvent(ctx context.Context, e CloudTrailEnvelope, rule Rule) (int64, *NotificationChannel, bool, error) {
	const q = `
INSERT INTO alert_events (
  event_id,
  account_id,
  region_code,
  event_source,
  event_name,
  severity,
  event_time,
  resource_type,
  resource_id,
  resource_name,
  user_arn,
  source_ip,
  raw_event_json,
  alert_status,
  matched_rule_id,
  matched_rule_name_snapshot,
  matched_rule_snapshot_json,
  notification_route_id,
  notification_channel_id
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17::jsonb,$18,$19
)
ON CONFLICT (event_id) DO NOTHING
RETURNING id`
	channel, err := c.resolveNotificationChannel(ctx, e, rule)
	if err != nil {
		return 0, nil, false, err
	}
	var channelID any
	if channel != nil {
		channelID = channel.ID
	}
	var id int64
	err = c.db.QueryRow(ctx, q,
		e.EventID,
		e.AWS.AccountID,
		nullIfEmpty(e.AWS.Region),
		nullIfEmpty(e.Event.EventSource),
		e.Event.EventName,
		nonEmpty(rule.Severity, "medium"),
		nonZeroTime(e.Event.EventTime),
		nullIfEmpty(e.Resource.ResourceType),
		nullIfEmpty(e.Resource.ResourceID),
		nullIfEmpty(e.Resource.ResourceName),
		nullIfEmpty(e.Actor.ARN),
		nullIfEmpty(e.Network.SourceIP),
		jsonOrNull(e.RawEvent),
		"new",
		rule.ID,
		nullIfEmpty(rule.RuleName),
		ruleSnapshotJSON(rule),
		rule.NotificationRouteID,
		channelID,
	).Scan(&id)
	if err == pgx.ErrNoRows {
		return 0, channel, false, nil
	}
	if err != nil {
		return 0, nil, false, err
	}
	return id, channel, true, nil
}

func (c *Consumer) resolveNotificationChannel(ctx context.Context, e CloudTrailEnvelope, rule Rule) (*NotificationChannel, error) {
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
			args: []any{e.AWS.AccountID},
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
		err := c.db.QueryRow(ctx, item.query, item.args...).Scan(&channel.ID, &channel.ChannelName, &channel.ChannelType, &botToken, &chatID)
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

func (c *Consumer) updateAlertNotificationStatus(ctx context.Context, alertEventID int64, channelID *int64, status string, notifiedAt *time.Time, notificationError any) error {
	const q = `
UPDATE alert_events
SET alert_status = $2,
    notification_channel_id = COALESCE($3, notification_channel_id),
    notified_at = $4,
    notification_error = $5
WHERE id = $1`
	_, err := c.db.Exec(ctx, q, alertEventID, status, channelID, notifiedAt, notificationError)
	return err
}

func sendNotification(channel NotificationChannel, e CloudTrailEnvelope, rule Rule) error {
	if !strings.EqualFold(strings.TrimSpace(channel.ChannelType), "telegram") {
		return fmt.Errorf("unsupported channel type: %s", channel.ChannelType)
	}
	if strings.TrimSpace(channel.BotToken) == "" || strings.TrimSpace(channel.ChatID) == "" {
		return fmt.Errorf("telegram channel missing bot token or chat id")
	}
	text := fmt.Sprintf(
		"🚨 SOC 告警事件\n规则: %s\n事件ID: %s\n事件名: %s\n事件源: %s\n账号: %s\n区域: %s\n资源类型: %s\n资源ID: %s\n操作人: %s\n源 IP: %s\n时间: %s\n等级: %s",
		nonEmpty(rule.RuleName, fmt.Sprintf("rule-%d", rule.ID)),
		nonEmpty(e.EventID, "unknown"),
		nonEmpty(e.Event.EventName, "unknown"),
		nonEmpty(e.Event.EventSource, "unknown"),
		nonEmpty(e.AWS.AccountID, "unknown"),
		nonEmpty(e.AWS.Region, "unknown"),
		nonEmpty(e.Resource.ResourceType, "unknown"),
		nonEmpty(e.Resource.ResourceID, "unknown"),
		nonEmpty(e.Actor.ARN, "unknown"),
		nonEmpty(e.Network.SourceIP, "unknown"),
		e.Event.EventTime.Format(time.RFC3339),
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

func timePtr(t time.Time) *time.Time { return &t }

func normalizeScopedEnvelope(envelope *CloudTrailEnvelope, cfg RuntimeConfig) {
	if envelope == nil || !shouldIngestEvent(envelope.Event.EventSource, envelope.Event.EventName, cfg) {
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
	if strings.TrimSpace(envelope.AWS.AccountID) == "" {
		envelope.AWS.AccountID = envelope.Actor.AccountID
	}
	if strings.TrimSpace(envelope.Resource.ResourceARN) == "" && strings.TrimSpace(envelope.Actor.ARN) != "" && strings.HasPrefix(strings.TrimSpace(envelope.Actor.ARN), "arn:") && strings.HasPrefix(envelope.Resource.ResourceType, "iam-") {
		envelope.Resource.ResourceARN = envelope.Actor.ARN
	}
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
		stringValue(request, "instanceId"),
		stringValue(response, "instanceId"),
		stringValue(request, "subnetId"),
		stringValue(response, "subnetId"),
		stringValue(request, "bucketName"),
		stringValue(request, "userName"),
	)

	resourceName := firstNonEmpty(
		stringValue(request, "groupName"),
		findFilterValue(request, "group-name"),
		stringValue(request, "roleSessionName"),
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

func rawMessageString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func normalizeRawJSON(raw json.RawMessage) json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	return json.RawMessage(trimmed)
}

func parseCloudTrailReadOnly(value any) *bool {
	switch typed := value.(type) {
	case bool:
		v := typed
		return &v
	case string:
		trimmed := strings.ToLower(strings.TrimSpace(typed))
		switch trimmed {
		case "true":
			v := true
			return &v
		case "false":
			v := false
			return &v
		}
	}
	return nil
}

func decodeS3ObjectKey(key string) string {
	replaced := strings.ReplaceAll(strings.TrimSpace(key), "+", " ")
	decoded, err := url.QueryUnescape(replaced)
	if err != nil {
		return replaced
	}
	return decoded
}

func shouldProcessCloudTrailObjectKey(key string) bool {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return false
	}
	if !strings.HasPrefix(trimmed, "AWSLogs/") {
		return false
	}
	if !strings.HasSuffix(trimmed, ".json.gz") {
		return false
	}
	if strings.Contains(trimmed, "/CloudTrail-Digest/") {
		return false
	}
	return strings.Contains(trimmed, "/CloudTrail/")
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

func clamp(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func looksLikeARN(value string) bool {
	return strings.HasPrefix(strings.TrimSpace(value), "arn:")
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

func enabledKeys(values map[string]bool) []string {
	return sortedAllowedEventNames(values)
}

func cloneBoolMap(values map[string]bool) map[string]bool {
	cloned := make(map[string]bool, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}

func normalizeEventMap(values []string, allowed map[string]bool) map[string]bool {
	result := map[string]bool{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || !allowed[trimmed] {
			continue
		}
		result[trimmed] = true
	}
	return result
}

func cloneTargets(values []TargetScope) []TargetScope {
	cloned := make([]TargetScope, 0, len(values))
	for _, item := range values {
		regions := make([]string, 0, len(item.Regions))
		regions = append(regions, item.Regions...)
		cloned = append(cloned, TargetScope{AccountID: item.AccountID, Regions: regions})
	}
	return cloned
}

func normalizeTargets(values []TargetScope) []TargetScope {
	grouped := map[string]map[string]bool{}
	for _, item := range values {
		accountID := strings.TrimSpace(item.AccountID)
		if accountID == "" {
			continue
		}
		if _, ok := grouped[accountID]; !ok {
			grouped[accountID] = map[string]bool{}
		}
		for _, region := range item.Regions {
			trimmed := strings.TrimSpace(region)
			if trimmed == "" {
				continue
			}
			grouped[accountID][trimmed] = true
		}
	}
	result := make([]TargetScope, 0, len(grouped))
	for accountID, regionsMap := range grouped {
		regions := make([]string, 0, len(regionsMap))
		for region := range regionsMap {
			regions = append(regions, region)
		}
		sort.Strings(regions)
		if len(regions) == 0 {
			continue
		}
		result = append(result, TargetScope{AccountID: accountID, Regions: regions})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].AccountID < result[j].AccountID
	})
	return result
}

func normalizeEventRules(values []IngestEventRule) []IngestEventRule {
	result := make([]IngestEventRule, 0, len(values))
	for _, rule := range values {
		eventSource := strings.TrimSpace(strings.ToLower(rule.EventSource))
		if eventSource == "" {
			continue
		}
		eventNames := make([]string, 0, len(rule.EventNames))
		seen := map[string]bool{}
		for _, item := range rule.EventNames {
			name := strings.TrimSpace(item)
			if name == "" || seen[strings.ToLower(name)] {
				continue
			}
			seen[strings.ToLower(name)] = true
			eventNames = append(eventNames, name)
		}
		if len(eventNames) == 0 {
			continue
		}
		sort.Strings(eventNames)
		result = append(result, IngestEventRule{EventSource: eventSource, EventNames: eventNames})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].EventSource < result[j].EventSource
	})
	return result
}

func cloneEventRules(values []IngestEventRule) []IngestEventRule {
	cloned := make([]IngestEventRule, 0, len(values))
	for _, rule := range values {
		names := make([]string, 0, len(rule.EventNames))
		names = append(names, rule.EventNames...)
		cloned = append(cloned, IngestEventRule{EventSource: rule.EventSource, EventNames: names})
	}
	return cloned
}

func cloneRuntimeConfig(cfg RuntimeConfig) RuntimeConfig {
	return RuntimeConfig{
		Enabled:    cfg.Enabled,
		QueueURL:   cfg.QueueURL,
		BatchSize:  cfg.BatchSize,
		WaitTime:   cfg.WaitTime,
		Visibility: cfg.Visibility,
		Targets:    cloneTargets(cfg.Targets),
		EventRules: cloneEventRules(cfg.EventRules),
	}
}

func shouldProcessTarget(targets []TargetScope, accountID, region string) bool {
	if len(targets) == 0 {
		return true
	}
	accountID = strings.TrimSpace(accountID)
	region = strings.TrimSpace(region)
	for _, target := range targets {
		if strings.TrimSpace(target.AccountID) != accountID {
			continue
		}
		for _, candidate := range target.Regions {
			if strings.TrimSpace(candidate) == region {
				return true
			}
		}
	}
	return false
}

func sleepWithContext(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
