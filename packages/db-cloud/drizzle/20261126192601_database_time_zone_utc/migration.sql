-- Custom SQL migration file, put your code below! ---- Better Auth's timestamps have no time zone. Drivers convert a JS Date to one through the session's
-- TimeZone, and Bun SQL and @effect/sql-pg do it differently, so on a server whose zone is not UTC
-- they wrote different instants, and comparisons with now() were off by the offset. Every new
-- session of this database now starts in UTC. Neon and the docker-compose image already default to it.
DO $$
BEGIN
	EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
