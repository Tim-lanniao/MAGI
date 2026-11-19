-- Count the new session lifetime from the original login and keep shorter expirations.
UPDATE sessions
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+24 hours')
WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+24 hours');

-- Earlier invites stored only an expiration, exactly ten minutes after issuance.
UPDATE invites
SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '-5 minutes')
WHERE used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
