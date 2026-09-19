import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAsyncAction } from "./useAsyncAction";

describe("useAsyncAction (Phase 6 §19 duplicate-submit protection)", () => {
  it("reuses ONE idempotency key for a submission and swallows the double-click", async () => {
    let resolve!: (v: string) => void;
    const fn = vi.fn(
      (_key: string) => new Promise<string>((r) => (resolve = r)),
    );
    const { result } = renderHook(() => useAsyncAction<[], string>(fn));

    // Two rapid fires — the second must not invoke the backend again.
    let p1: Promise<string | null>;
    let p2: Promise<string | null>;
    act(() => {
      p1 = result.current.run();
      p2 = result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.running).toBe(true);

    const keys = fn.mock.calls.map((c) => c[0]);
    await act(async () => {
      resolve("ok");
      await Promise.all([p1!, p2!]);
    });

    expect(keys).toHaveLength(1); // stable key, minted once
    expect(result.current.data).toBe("ok");
    expect(result.current.running).toBe(false);
  });

  it("mints a fresh key only after reset (a genuinely new submission)", async () => {
    const fn = vi.fn(async (key: string) => key);
    const { result } = renderHook(() => useAsyncAction<[], string>(fn));

    const first = await act(async () => result.current.run());
    act(() => result.current.reset());
    const second = await act(async () => result.current.run());

    expect(first).not.toBe(second);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exposes the error and stays re-runnable on failure", async () => {
    const keys: string[] = [];
    let calls = 0;
    const fn = async (key: string): Promise<string> => {
      keys.push(key);
      calls += 1;
      if (calls === 1) throw new Error("nope");
      return "recovered";
    };
    const { result } = renderHook(() => useAsyncAction<[], string>(fn));

    await act(async () => result.current.run());
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.running).toBe(false);

    // Retry reuses the same key (same logical submission) and can succeed.
    const ok = await act(async () => result.current.run());
    expect(ok).toBe("recovered");
    expect(keys[0]).toBe(keys[1]);
  });
});
