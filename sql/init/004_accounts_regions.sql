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
  ('577364091059', 'AWS Account 577364091059', '导入账号'),
  ('446383248756', 'AWS Account 446383248756', '导入账号'),
  ('135808916487', 'AWS Account 135808916487', '导入账号'),
  ('156041432019', 'AWS Account 156041432019', '导入账号'),
  ('247890563706', 'AWS Account 247890563706', '导入账号'),
  ('839169402617', 'AWS Account 839169402617', '导入账号'),
  ('742372923113', 'AWS Account 742372923113', '导入账号'),
  ('951656659734', 'AWS Account 951656659734', '导入账号'),
  ('076991469592', 'AWS Account 076991469592', '导入账号'),
  ('400928259799', 'AWS Account 400928259799', '导入账号'),
  ('201805606249', 'AWS Account 201805606249', '导入账号'),
  ('746669223461', 'AWS Account 746669223461', '导入账号'),
  ('828289321688', 'AWS Account 828289321688', '导入账号'),
  ('919664458431', 'AWS Account 919664458431', '导入账号'),
  ('837256265149', 'AWS Account 837256265149', '导入账号'),
  ('211326840893', 'AWS Account 211326840893', '导入账号'),
  ('809893975949', 'Security Account', '安全主账号 / central security account'),
  ('178502901686', 'AWS Account 178502901686', '导入账号'),
  ('582998837184', 'AWS Account 582998837184', '导入账号'),
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
