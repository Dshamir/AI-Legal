-- Enable Row-Level Security with deny-all default policy on all public tables.
-- Prisma's service-role connection bypasses RLS; this blocks PostgREST
-- anon/authenticated roles from reading any data directly.
--
-- Run: psql $DATABASE_URL -f backend/sql/001_rls_deny_all.sql

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOR tbl IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma_%'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    END LOOP;
END $$;

-- Auto-enable RLS on any future table created in the public schema
CREATE OR REPLACE FUNCTION public.auto_enable_rls()
RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE
    obj RECORD;
BEGIN
    FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
        WHERE command_tag = 'CREATE TABLE' AND object_type = 'table'
    LOOP
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
        EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.object_identity);
    END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS enforce_rls_on_new_tables;
CREATE EVENT TRIGGER enforce_rls_on_new_tables
    ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE')
    EXECUTE FUNCTION public.auto_enable_rls();
