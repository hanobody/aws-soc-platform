BEGIN;

UPDATE aws_accounts
SET note = COALESCE(note, account_name)
WHERE note IS NULL;

UPDATE aws_regions
SET region_group = COALESCE(region_group, display_name)
WHERE region_group IS NULL;

ALTER TABLE aws_regions
  ALTER COLUMN region_group SET NOT NULL;

ALTER TABLE aws_accounts
  DROP COLUMN IF EXISTS environment,
  DROP COLUMN IF EXISTS enabled;

ALTER TABLE aws_regions
  DROP COLUMN IF EXISTS partition_name,
  DROP COLUMN IF EXISTS default_enabled,
  DROP COLUMN IF EXISTS enabled;

ALTER TABLE resource_types
  DROP COLUMN IF EXISTS enabled;

ALTER TABLE event_types
  DROP COLUMN IF EXISTS notify_enabled,
  DROP COLUMN IF EXISTS enabled;

COMMIT;
