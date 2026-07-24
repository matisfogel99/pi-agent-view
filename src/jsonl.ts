import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export interface JsonLineReaderOptions {
  /** Bounds memory even when a hostile peer never sends LF. */
  maximumLineLength?: number;
}

/** Pi RPC uses LF-only JSONL framing; readline is intentionally not used. */
export function readJsonLines(
  stream: Readable,
  onValue: (value: unknown) => void,
  onError: (error: Error) => void,
  options: JsonLineReaderOptions = {},
): () => void {
  const decoder = new StringDecoder("utf8");
  const maximumLineLength = Math.max(1, options.maximumLineLength ?? 1024 * 1024);
  let buffer = "";
  let discardingOversizedLine = false;

  const consume = (final = false) => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (discardingOversizedLine) {
        discardingOversizedLine = false;
        continue;
      }
      if (line.length > maximumLineLength) {
        onError(new Error(`JSONL record exceeds ${maximumLineLength} characters`));
        continue;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      parse(line);
    }
    if (buffer.length > maximumLineLength && !discardingOversizedLine) {
      discardingOversizedLine = true;
      buffer = "";
      onError(new Error(`JSONL record exceeds ${maximumLineLength} characters`));
    }
    if (final && buffer.length > 0 && !discardingOversizedLine) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      parse(line);
    }
  };

  const parse = (line: string) => {
    if (!line) return;
    try {
      onValue(JSON.parse(line));
    } catch (cause) {
      onError(new Error(`Invalid JSONL record: ${line.slice(0, 200)}`, { cause }));
    }
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    consume();
  };
  const onEnd = () => {
    buffer += decoder.end();
    consume(true);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
