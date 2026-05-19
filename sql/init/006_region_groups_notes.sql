ALTER TABLE aws_accounts
  ADD COLUMN IF NOT EXISTS note TEXT;

ALTER TABLE aws_regions
  ADD COLUMN IF NOT EXISTS region_group VARCHAR(80);

UPDATE aws_accounts
SET note = COALESCE(note, account_name)
WHERE note IS NULL;

INSERT INTO aws_accounts (account_id, account_name, note)
VALUES
  ('809893975949', 'Security Account', '安全主账号 / central security account'),
  ('516199268720', 'Member Account', '成员账号 / sample member account')
ON CONFLICT (account_id) DO UPDATE SET
  account_name = EXCLUDED.account_name,
  note = COALESCE(aws_accounts.note, EXCLUDED.note);

INSERT INTO aws_regions (region_code, display_name, region_group)
VALUES
  ('af-south-1', 'Africa (Cape Town)', 'Africa'),
  ('ap-east-1', 'Asia Pacific (Hong Kong)', 'Asia Pacific'),
  ('ap-east-2', 'Asia Pacific (Taipei)', 'Asia Pacific'),
  ('ap-south-2', 'Asia Pacific (Hyderabad)', 'Asia Pacific'),
  ('ap-southeast-3', 'Asia Pacific (Jakarta)', 'Asia Pacific'),
  ('ap-southeast-4', 'Asia Pacific (Melbourne)', 'Asia Pacific'),
  ('ap-southeast-5', 'Asia Pacific (Malaysia)', 'Asia Pacific'),
  ('ap-southeast-6', 'Asia Pacific (New Zealand)', 'Asia Pacific'),
  ('ap-southeast-7', 'Asia Pacific (Thailand)', 'Asia Pacific'),
  ('ca-west-1', 'Canada (Calgary)', 'Canada'),
  ('eu-central-2', 'Europe (Zurich)', 'Europe'),
  ('eu-south-1', 'Europe (Milan)', 'Europe'),
  ('eu-south-2', 'Europe (Spain)', 'Europe'),
  ('il-central-1', 'Israel (Tel Aviv)', 'Israel'),
  ('me-central-1', 'Middle East (UAE)', 'Middle East'),
  ('me-south-1', 'Middle East (Bahrain)', 'Middle East'),
  ('mx-central-1', 'Mexico (Central)', 'Mexico'),
  ('ap-northeast-1', 'Asia Pacific (Tokyo)', 'Asia Pacific'),
  ('ap-northeast-2', 'Asia Pacific (Seoul)', 'Asia Pacific'),
  ('ap-northeast-3', 'Asia Pacific (Osaka)', 'Asia Pacific'),
  ('ap-south-1', 'Asia Pacific (Mumbai)', 'Asia Pacific'),
  ('ap-southeast-1', 'Asia Pacific (Singapore)', 'Asia Pacific'),
  ('ap-southeast-2', 'Asia Pacific (Sydney)', 'Asia Pacific'),
  ('ca-central-1', 'Canada (Central)', 'Canada'),
  ('eu-central-1', 'Europe (Frankfurt)', 'Europe'),
  ('eu-north-1', 'Europe (Stockholm)', 'Europe'),
  ('eu-west-1', 'Europe (Ireland)', 'Europe'),
  ('eu-west-2', 'Europe (London)', 'Europe'),
  ('eu-west-3', 'Europe (Paris)', 'Europe'),
  ('sa-east-1', 'South America (São Paulo)', 'South America'),
  ('us-east-1', 'United States (N. Virginia)', 'United States'),
  ('us-east-2', 'United States (Ohio)', 'United States'),
  ('us-west-1', 'United States (N. California)', 'United States'),
  ('us-west-2', 'United States (Oregon)', 'United States')
ON CONFLICT (region_code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  region_group = EXCLUDED.region_group;
