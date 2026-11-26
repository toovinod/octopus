-- Custom SQL migration file, put your code below! --
-- Two invitations accepted for the same user, or an accept racing a direct add, gave a user two
-- rows in one org, and removing one left their access. Keep one row per user so the next
-- migration can add the unique index: the highest role, so an owner is never demoted, then the oldest.
-- A Better Auth role can list several roles separated by commas, and counts as its highest one.
DELETE FROM "member"
WHERE "id" IN (
	SELECT "id"
	FROM (
		SELECT "id", row_number() OVER (
			PARTITION BY "organization_id", "user_id"
			ORDER BY
				CASE
					WHEN 'owner' = ANY (string_to_array(replace("role", ' ', ''), ',')) THEN 0
					WHEN 'admin' = ANY (string_to_array(replace("role", ' ', ''), ',')) THEN 1
					ELSE 2
				END,
				"created_at",
				"id"
		) AS "position"
		FROM "member"
	) AS "ranked"
	WHERE "position" > 1
);
