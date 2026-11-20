-- Closes of pull requests that earlier versions left unrecorded count as
-- handled, so that the first poll after this version no longer acts on them
-- (it would now remove the clones they came from). Kept unhandled: closes
-- whose autoclose is due (a session not autoclosed, a pull request with
-- autoclose, none open), which the first poll after a restart picks up.
UPDATE `pull_requests`
SET `close_handled_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE `state` != 'open'
  AND `close_handled_at` IS NULL
  AND NOT (
    EXISTS (
      SELECT 1 FROM `sessions` AS `s`
      WHERE `s`.`id` = `pull_requests`.`session_id` AND `s`.`autoclosed_at` IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM `pull_requests` AS `p`
      WHERE `p`.`session_id` = `pull_requests`.`session_id` AND `p`.`autoclose` = 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM `pull_requests` AS `p`
      WHERE `p`.`session_id` = `pull_requests`.`session_id` AND `p`.`state` = 'open'
    )
  );
