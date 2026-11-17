-- Automatically initialize development and test databases for Konfirm
-- POSTGRES_DB (konfirm_dev) is initialized automatically by Postgres image.
-- This script creates the dedicated test database used by npm run test:fast.

SELECT 'CREATE DATABASE konfirm_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'konfirm_test')\gexec
