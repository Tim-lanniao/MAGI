CREATE TABLE model_settings (
  voter TEXT PRIMARY KEY CHECK (voter IN ('gpt','deepseek')),
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  user_selected INTEGER NOT NULL DEFAULT 0 CHECK (user_selected IN (0,1))
);

-- Keep the requested settings separate from the model ID actually returned by the provider.
ALTER TABLE votes ADD COLUMN requested_model TEXT;
ALTER TABLE votes ADD COLUMN requested_effort TEXT;
