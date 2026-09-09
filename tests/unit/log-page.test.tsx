// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import LogsPage from "@/app/logs/page";

const initialLog = "[2026-09-08 10:20:30.123] [INFO] Session started.\n";
const updatedLog = initialLog + "[2026-09-08 10:20:32.123] [ERROR] Connection failed.\n    Cause: Offline.\n";
const fetchMock = vi.fn<typeof fetch>();
const disconnect = vi.fn();
let visibility: DocumentVisibilityState;

async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<LogsPage />); });
  return view;
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

async function setVisibility(value: DocumentVisibilityState) {
  await act(async () => {
    visibility = value;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function pendingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  disconnect.mockReset();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() { disconnect(); }
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("automatic session log loading", () => {
  test("polls every two seconds, retains content on errors, and recovers automatically", async () => {
    fetchMock.mockResolvedValueOnce(new Response(initialLog))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(updatedLog));
    const view = await mount();
    expect(view.container.textContent).toContain("Session started.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.cache).toBe("no-store");
    await advance(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toContain("正在自动重试");
    expect(view.container.textContent).toContain("Session started.");
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(view.container.textContent).toContain("Cause: Offline.");
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("does not overlap slow requests and retries after a timeout", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(initialLog))).mockImplementationOnce(pendingFetch);
    await mount();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    await advance(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await advance(1);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("pauses hidden pages, aborts their pending reads, and refreshes on return", async () => {
    fetchMock.mockResolvedValueOnce(new Response(initialLog))
      .mockImplementationOnce(pendingFetch)
      .mockResolvedValueOnce(new Response(updatedLog));
    const view = await mount();
    await advance(2_000);
    const signal = fetchMock.mock.calls[1][1]?.signal;
    await setVisibility("hidden");
    expect(signal?.aborted).toBe(true);
    await advance(6_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
    await setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(view.container.textContent).toContain("Connection failed.");
  });

  test("an initially hidden page waits until visible and renders an empty state", async () => {
    visibility = "hidden";
    fetchMock.mockResolvedValue(new Response(""));
    await mount();
    await advance(6_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("当前会话暂无日志。");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("unmount cancels work and ignores even a late response that disregards abort", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await mount();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await act(async () => { finish(new Response(updatedLog)); });
    await setVisibility("hidden");
    await setVisibility("visible");
    await advance(6_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
