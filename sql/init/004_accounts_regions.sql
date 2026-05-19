CREATE TABLE IF NOT EXISTS aws_accounts (
  id BIGSERIAL PRIMARY KEY,
  account_id VARCHAR(32) NOT NULL UNIQUE,
  account_name VARCHAR(120),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aws_regions (
  id BIGSERIAL PRIMARY KEY,
  region_code VARCHAR(32) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  region_group VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE alert_rules
  ADD COLUMN IF NOT EXISTS region_code VARCHAR(32);

ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS region_code VARCHAR(32);

INSERT INTO aws_accounts (account_id, account_name, note)
VALUES
  ('809893975949', 'Security Account', '安全主账号 / central security account'),
  ('516199268720', 'Member Account', '成员账号 / sample member account')
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO aws_regions (region_code, display_name, region_group)
VALUES
  ('af-south-1', 'Africa (Cape Town)', 'Africa'),
  ('ap-east-1', 'Asia Pacific (Hong Kong)', 'Asia Pacific'),
  ('ap-east-2', 'Asia Pacific (Taipei)', 'Asia Pacific'),
  ('ap-northeast-1', 'Asia Pacific (Tokyo)', 'Asia Pacific'),
  ('ap-northeast-2', 'Asia Pacific (Seoul)', 'Asia Pacific'),
  ('ap-northeast-3', 'Asia Pacific (Osaka)', 'Asia Pacific'),
  ('ap-south-1', 'Asia Pacific (Mumbai)', 'Asia Pacific'),
  ('ap-south-2', 'Asia Pacific (Hyderabad)', 'Asia Pacific'),
  ('ap-southeast-1', 'Asia Pacific (Singapore)', 'Asia Pacific'),
  ('ap-southeast-2', 'Asia Pacific (Sydney)', 'Asia Pacific'),
  ('ap-southeast-3', 'Asia Pacific (Jakarta)', 'Asia Pacific'),
  ('ap-southeast-4', 'Asia Pacific (Melbourne)', 'Asia Pacific'),
  ('ap-southeast-5', 'Asia Pacific (Malaysia)', 'Asia Pacific'),
  ('ap-southeast-6', 'Asia Pacific (New Zealand)', 'Asia Pacific'),
  ('ap-southeast-7', 'Asia Pacific (Thailand)', 'Asia Pacific'),
  ('ca-central-1', 'Canada (Central)', 'Canada'),
  ('ca-west-1', 'Canada (Calgary)', 'Canada'),
  ('eu-central-1', 'Europe (Frankfurt)', 'Europe'),
  ('eu-central-2', 'Europe (Zurich)', 'Europe'),
  ('eu-north-1', 'Europe (Stockholm)', 'Europe'),
  ('eu-south-1', 'Europe (Milan)', 'Europe'),
  ('eu-south-2', 'Europe (Spain)', 'Europe'),
  ('eu-west-1', 'Europe (Ireland)', 'Europe'),
  ('eu-west-2', 'Europe (London)', 'Europe'),
  ('eu-west-3', 'Europe (Paris)', 'Europe'),
  ('il-central-1', 'Israel (Tel Aviv)', 'Israel'),
  ('me-central-1', 'Middle East (UAE)', 'Middle East'),
  ('me-south-1', 'Middle East (Bahrain)', 'Middle East'),
  ('mx-central-1', 'Mexico (Central)', 'Mexico'),
  ('sa-east-1', 'South America (São Paulo)', 'South America'),
  ('us-east-1', 'United States (N. Virginia)', 'United States'),
  ('us-east-2', 'United States (Ohio)', 'United States'),
  ('us-west-1', 'United States (N. California)', 'United States'),
  ('us-west-2', 'United States (Oregon)', 'United States')
ON CONFLICT (region_code) DO NOTHING;
