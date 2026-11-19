CREATE TABLE app_user (
  id INTEGER PRIMARY KEY CHECK (id=1), user_handle BLOB NOT NULL CHECK(length(user_handle)=32), created_at TEXT NOT NULL
);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL, device_name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE invites (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE challenges (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('register','login')),
  challenge TEXT NOT NULL, expires_at TEXT NOT NULL, invite_hash TEXT, device_name TEXT
);
CREATE INDEX challenges_expiry ON challenges(expires_at);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE questions (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, background TEXT NOT NULL, goals TEXT NOT NULL,
  reversibility TEXT NOT NULL CHECK(reversibility IN ('可逆','不可逆')),
  parent_id TEXT REFERENCES questions(id), new_info TEXT, status TEXT NOT NULL
    CHECK(status IN ('running','needs_confirmation','paused','decided','failed')),
  next_status TEXT CHECK(next_status IN ('decided','needs_confirmation','failed')), created_at TEXT NOT NULL, decided_at TEXT
);
CREATE UNIQUE INDEX question_material ON questions(question,background,goals,reversibility,ifnull(parent_id,''),ifnull(new_info,''));
CREATE TABLE votes (
  question_id TEXT NOT NULL REFERENCES questions(id), voter TEXT NOT NULL CHECK(voter IN ('user','gpt','deepseek')),
  state TEXT NOT NULL CHECK(state IN ('pending','valid','absent')), vote TEXT CHECK(vote IN ('是','否')),
  confidence INTEGER CHECK(confidence BETWEEN 50 AND 100), core_reason TEXT, conditions TEXT, risks TEXT,
  flip_condition TEXT, model_name TEXT, model_params TEXT, raw_response TEXT, reasoning_content TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, usage TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(question_id,voter), CHECK(voter <> 'user' OR state='valid'),
  CHECK(state <> 'valid' OR (vote IS NOT NULL AND confidence IS NOT NULL AND core_reason IS NOT NULL
    AND conditions IS NOT NULL AND risks IS NOT NULL AND flip_condition IS NOT NULL))
);
CREATE TRIGGER lock_valid_vote BEFORE UPDATE ON votes WHEN OLD.state='valid'
BEGIN SELECT RAISE(ABORT,'valid vote is locked'); END;
CREATE TRIGGER lock_absent_vote BEFORE UPDATE ON votes WHEN OLD.state='absent' AND
  (NEW.state <> 'pending' OR (SELECT status FROM questions WHERE id=OLD.question_id) <> 'failed')
BEGIN SELECT RAISE(ABORT,'absent vote is locked'); END;
CREATE TABLE model_attempts (
  id INTEGER PRIMARY KEY, question_id TEXT NOT NULL, voter TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, model_name TEXT NOT NULL, model_params TEXT NOT NULL, raw_response TEXT,
  usage TEXT, latency_ms INTEGER, error TEXT, provider_status INTEGER, provider_code TEXT,
  FOREIGN KEY(question_id,voter) REFERENCES votes(question_id,voter)
);
CREATE UNIQUE INDEX one_active_attempt ON model_attempts(question_id,voter) WHERE finished_at IS NULL;
CREATE TABLE results (
  question_id TEXT PRIMARY KEY REFERENCES questions(id), tally TEXT NOT NULL, merged_risks TEXT NOT NULL,
  conditions TEXT NOT NULL, conclusion TEXT, final_decision TEXT, final_reason TEXT, final_note TEXT
);
CREATE TABLE risk_checks (
  question_id TEXT NOT NULL REFERENCES questions(id), risk_id TEXT NOT NULL, done_at TEXT NOT NULL,
  PRIMARY KEY(question_id,risk_id)
);
CREATE TABLE outcomes (
  question_id TEXT PRIMARY KEY REFERENCES questions(id),
  correct_answer TEXT NOT NULL CHECK(correct_answer IN ('是','否','说不清')), note TEXT, recorded_at TEXT NOT NULL
);
