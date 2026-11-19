-- Runs once, on first container start, via docker-entrypoint-initdb.d.
-- POSTGRES_DB already creates konfirm_dev; add the test database the suite
-- expects so a fresh clone needs no manual createdb.
CREATE DATABASE konfirm_test OWNER konfirm;
