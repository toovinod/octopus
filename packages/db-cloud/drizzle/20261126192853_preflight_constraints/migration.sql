-- Custom SQL migration file, put your code below! --
-- The next migration adds a unique index on account (provider_id, account_id) and checks on
-- cloud_workspace. Rows that break them cannot be fixed here: two accounts for one identity may
-- belong to different users, and an unknown state needs a person to say what it meant. Stop with
-- a message that says what to fix, instead of a bare index or check error.
DO $$
DECLARE
	duplicate_identities integer;
	unknown_workspaces integer;
BEGIN
	SELECT count(*) INTO duplicate_identities
	FROM (
		SELECT 1 FROM "account" GROUP BY "provider_id", "account_id" HAVING count(*) > 1
	) AS "duplicates";
	IF duplicate_identities > 0 THEN
		RAISE EXCEPTION 'Identities linked to more than one account row: %', duplicate_identities
			USING HINT = 'Find them with: SELECT provider_id, account_id, array_agg(user_id) FROM account GROUP BY 1, 2 HAVING count(*) > 1. Keep one row per identity, then migrate again.';
	END IF;

	SELECT count(*) INTO unknown_workspaces
	FROM "cloud_workspace"
	WHERE "requested_state" NOT IN ('running', 'stopped', 'archived')
		OR "observed_state" NOT IN ('provisioning', 'running', 'sleeping', 'stopped', 'failed', 'unknown')
		OR "sandbox_provider" NOT IN ('vercel');
	IF unknown_workspaces > 0 THEN
		RAISE EXCEPTION 'cloud_workspace rows with a state or sandbox provider the code does not know: %', unknown_workspaces
			USING HINT = 'Set requested_state, observed_state and sandbox_provider to values in packages/db-cloud/src/cloudWorkspace.ts, or delete the rows, then migrate again.';
	END IF;
END
$$;
