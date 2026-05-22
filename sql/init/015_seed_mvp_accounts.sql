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
ON CONFLICT (account_id) DO UPDATE SET
  account_name = EXCLUDED.account_name,
  note = COALESCE(NULLIF(aws_accounts.note, ''), EXCLUDED.note);
