-- Sessions now belong to a login (control database app_user). NULL = legacy single-operator session.
ALTER TABLE operator_session ADD COLUMN user_id TEXT;
