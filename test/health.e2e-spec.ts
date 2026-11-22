import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { pool } from "../src/db/pool";

describe("GET /health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("returns 200 when the database answers", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });

  it("returns 503 when the database query fails", async () => {
    jest
      .spyOn(pool, "query")
      .mockImplementation((() =>
        Promise.reject(new Error("connection refused"))) as never);
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(503);
  });

  it("is not rate limited", async () => {
    for (let i = 0; i < 65; i++) {
      const res = await request(app.getHttpServer()).get("/health");
      expect(res.status).not.toBe(429);
    }
  });

  it("returns correct content-type header", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("handles database timeout gracefully", async () => {
    jest
      .spyOn(pool, "query")
      .mockImplementation(
        (() =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 100),
          )) as never,
      );
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty("status");
  });

  it("handles multiple concurrent health checks", async () => {
    const requests = Array.from({ length: 10 }, () =>
      request(app.getHttpServer()).get("/health"),
    );
    const responses = await Promise.all(requests);
    responses.forEach((res) => {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", db: "ok" });
    });
  });

  it("returns valid JSON structure on success", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("db");
    expect(typeof res.body.status).toBe("string");
    expect(typeof res.body.db).toBe("string");
  });

  it("returns error details when database connection is lost", async () => {
    const mockError = new Error("ECONNREFUSED: Connection refused");
    jest
      .spyOn(pool, "query")
      .mockImplementation((() => Promise.reject(mockError)) as never);
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).not.toBe("ok");
  });
});
