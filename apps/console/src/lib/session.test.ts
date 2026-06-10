import { describe, expect, it } from "vitest";
import { decodeSession, encodeSession } from "./session.js";

const secret = "test-secret-32-chars-aaaaaaaaaaaa";

describe("session", () => {
  it("编码后可解回", () => {
    const v = encodeSession({ userId: "u1", role: "admin", exp: 9999999999 }, secret);
    expect(decodeSession(v, secret)).toEqual({ userId: "u1", role: "admin", exp: 9999999999 });
  });
  it("签名被篡改返回 null", () => {
    const v = encodeSession({ userId: "u1", role: "user", exp: 9999999999 }, secret);
    expect(decodeSession(`${v.slice(0, -2)}xx`, secret)).toBeNull();
    expect(decodeSession(v, "another-secret-32-chars-bbbbbbbb")).toBeNull();
  });
  it("过期返回 null;畸形返回 null", () => {
    const v = encodeSession({ userId: "u1", role: "user", exp: 1 }, secret);
    expect(decodeSession(v, secret)).toBeNull();
    expect(decodeSession("garbage", secret)).toBeNull();
    expect(decodeSession(undefined, secret)).toBeNull();
  });
});
