CREATE TABLE IF NOT EXISTS worker_status (
  worker_name VARCHAR(80) PRIMARY KEY,
  worker_type VARCHAR(80) NOT NULL,
  status VARCHAR(32) NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_status_type ON worker_status(worker_type);
CREATE INDEX IF NOT EXISTS idx_worker_status_heartbeat ON worker_status(last_heartbeat_at DESC);
