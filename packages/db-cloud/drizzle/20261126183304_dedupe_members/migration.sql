-- Custom SQL migration file, put your code below! ---- Two invitations accepted for the same user, or an accept racing a direct add, gave a user two
-- rows in one org, and removing one left their access. Keep each user's oldest row so the next
-- migration can add the unique index.
DELETE FROM "member" AS "newer"
USING "member" AS "older"
WHERE "newer"."organization_id" = "older"."organization_id"
	AND "newer"."user_id" = "older"."user_id"
	AND ("older"."created_at", "older"."id") < ("newer"."created_at", "newer"."id");
