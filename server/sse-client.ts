// A minimal SSE reader for tests and the verifier: collects `{event, data}` messages from a URL until stopped.
export interface SseMsg { event: string; data: unknown }

export function sseCollect(url: string): { msgs: SseMsg[]; until(pred: (m: SseMsg[]) => boolean, ms?: number): Promise<void>; close(): void } {
  const msgs: SseMsg[] = [];
  const ac = new AbortController();
  let buf = "";
  (async () => {
    try {
      const r = await fetch(url, { signal: ac.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k: number;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          let event = "message"; const data: string[] = [];
          for (const l of block.split("\n")) {
            if (l.startsWith("event: ")) event = l.slice(7);
            else if (l.startsWith("data: ")) data.push(l.slice(6));
          }
          if (data.length) msgs.push({ event, data: JSON.parse(data.join("\n")) });
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    msgs,
    async until(pred, ms = 5000) {
      const t0 = Date.now();
      while (!pred(msgs)) {
        if (Date.now() - t0 > ms) throw new Error(`sse: condition not met in ${ms} ms (${msgs.length} msgs)`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() { ac.abort(); },
  };
}
