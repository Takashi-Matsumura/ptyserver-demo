export const FrameType = {
  Stdin: 0x00,
  Stdout: 0x01,
  Resize: 0x02,
  Status: 0x03,
  Ping: 0x04,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export type ResizePayload = { cols: number; rows: number };
export type StatusPayload = { kind: "spawn" | "exit"; code?: number };

export type DecodedFrame =
  | { type: typeof FrameType.Stdin; payload: Uint8Array }
  | { type: typeof FrameType.Stdout; payload: Uint8Array }
  | { type: typeof FrameType.Resize; payload: ResizePayload }
  | { type: typeof FrameType.Status; payload: StatusPayload }
  | { type: typeof FrameType.Ping; payload: Uint8Array };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function prefix(type: FrameTypeValue, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = type;
  out.set(body, 1);
  return out;
}

export function encodeStdin(data: Uint8Array): Uint8Array {
  return prefix(FrameType.Stdin, data);
}

export function encodeStdout(data: Uint8Array): Uint8Array {
  return prefix(FrameType.Stdout, data);
}

export function encodeResize(cols: number, rows: number): Uint8Array {
  return prefix(FrameType.Resize, textEncoder.encode(JSON.stringify({ cols, rows })));
}

export function encodeStatus(status: StatusPayload): Uint8Array {
  return prefix(FrameType.Status, textEncoder.encode(JSON.stringify(status)));
}

export function encodePing(): Uint8Array {
  return new Uint8Array([FrameType.Ping]);
}

export function decode(buffer: ArrayBuffer | ArrayBufferView): DecodedFrame {
  const view =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.byteLength < 1) {
    throw new Error("empty frame");
  }
  const type = view[0] as FrameTypeValue;
  const body = view.subarray(1);
  switch (type) {
    case FrameType.Stdin:
    case FrameType.Stdout:
      return { type, payload: new Uint8Array(body) };
    case FrameType.Resize: {
      const json = JSON.parse(textDecoder.decode(body)) as ResizePayload;
      return { type, payload: json };
    }
    case FrameType.Status: {
      const json = JSON.parse(textDecoder.decode(body)) as StatusPayload;
      return { type, payload: json };
    }
    case FrameType.Ping:
      return { type, payload: new Uint8Array(body) };
    default:
      throw new Error(`unknown frame type: 0x${(type as number).toString(16)}`);
  }
}
