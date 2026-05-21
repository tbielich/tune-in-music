import fs from "node:fs";
import path from "node:path";

import { logger } from "./logger";
import { toError } from "./utils";

const DEV_INPUT_DIR = "/dev/input";
const SYS_CLASS_INPUT_DIR = "/sys/class/input";

// Assumption: Linux input_event layout on 64-bit kernels
// struct input_event { struct timeval; __u16 type; __u16 code; __s32 value; }
// timeval = 2x long (8 bytes each) => total event size = 24 bytes.
const INPUT_EVENT_SIZE_BYTES = 24;
const INPUT_EVENT_TYPE_OFFSET = 16;
const INPUT_EVENT_CODE_OFFSET = 18;
const INPUT_EVENT_VALUE_OFFSET = 20;

const EV_KEY = 0x01;
const KEY_DOWN = 1;
const KEY_REPEAT = 2;

const KEY_PLAYPAUSE = 164;
const KEY_NEXTSONG = 163;
const KEY_PREVIOUSSONG = 165;
const KEY_STOPCD = 166;
const KEY_VOLUMEUP = 115;
const KEY_VOLUMEDOWN = 114;
const KEY_MUTE = 113;

const actionByKeyCode = new Map<number, MediaKeyAction>([
  [KEY_PLAYPAUSE, "TOGGLE_PAUSE"],
  [KEY_NEXTSONG, "NEXT"],
  [KEY_PREVIOUSSONG, "PREV"],
  [KEY_STOPCD, "RELOAD"],
  [KEY_VOLUMEUP, "VOL_UP"],
  [KEY_VOLUMEDOWN, "VOL_DOWN"],
  [KEY_MUTE, "TOGGLE_MUTE"],
]);

export type MediaKeyAction =
  | "TOGGLE_PAUSE"
  | "NEXT"
  | "PREV"
  | "RELOAD"
  | "VOL_UP"
  | "VOL_DOWN"
  | "TOGGLE_MUTE";

export interface MediaKeyListenerOptions {
  onTogglePause: () => void | Promise<void>;
  onNext: () => void | Promise<void>;
  onPrev: () => void | Promise<void>;
  onReload: () => void | Promise<void>;
  onVolUp: () => void | Promise<void>;
  onVolDown: () => void | Promise<void>;
  onToggleMute: () => void | Promise<void>;
}

interface InputEvent {
  type: number;
  code: number;
  value: number;
}

function toBoolString(value: boolean): string {
  return value ? "1" : "0";
}

function getEventIndex(fileName: string): number {
  const match = fileName.match(/^event(\d+)$/);
  const indexText = match?.[1];
  if (!indexText) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number.parseInt(indexText, 10);
}

function readDeviceName(devicePath: string): string {
  const eventName = path.basename(devicePath);
  const namePath = path.join(SYS_CLASS_INPUT_DIR, eventName, "device", "name");
  try {
    const fromSys = fs.readFileSync(namePath, "utf8").trim();
    if (fromSys.length > 0) {
      return fromSys;
    }
  } catch {
    // fallback below
  }
  return eventName;
}

function listEventDevices(): string[] {
  const entries = fs.readdirSync(DEV_INPUT_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => /^event\d+$/.test(entry.name))
    .sort((left, right) => getEventIndex(left.name) - getEventIndex(right.name))
    .map((entry) => path.join(DEV_INPUT_DIR, entry.name));
}

function parseInputEvent64(buffer: Buffer): InputEvent {
  return {
    type: buffer.readUInt16LE(INPUT_EVENT_TYPE_OFFSET),
    code: buffer.readUInt16LE(INPUT_EVENT_CODE_OFFSET),
    value: buffer.readInt32LE(INPUT_EVENT_VALUE_OFFSET),
  };
}

function shouldHandleValue(action: MediaKeyAction, value: number): boolean {
  if (value === KEY_DOWN) {
    return true;
  }
  if (value !== KEY_REPEAT) {
    return false;
  }
  return action === "VOL_UP" || action === "VOL_DOWN";
}

function dispatchAction(action: MediaKeyAction, options: MediaKeyListenerOptions): void {
  const handlerByAction: Record<MediaKeyAction, () => void | Promise<void>> = {
    TOGGLE_PAUSE: options.onTogglePause,
    NEXT: options.onNext,
    PREV: options.onPrev,
    RELOAD: options.onReload,
    VOL_UP: options.onVolUp,
    VOL_DOWN: options.onVolDown,
    TOGGLE_MUTE: options.onToggleMute,
  };

  const handler = handlerByAction[action];
  void Promise.resolve()
    .then(() => handler())
    .catch((error) => {
      logger.warn("MEDIA_KEY_ACTION_FAILED", {
        action,
        error: toError(error),
      });
    });
}

function openDevice(
  devicePath: string,
  options: MediaKeyListenerOptions,
): fs.ReadStream {
  const deviceName = readDeviceName(devicePath);
  const stream = fs.createReadStream(devicePath, {
    flags: "r",
    highWaterMark: INPUT_EVENT_SIZE_BYTES * 8,
  });

  let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  stream.on("open", () => {
    logger.info("MEDIA_KEY_DEVICE_OPEN", {
      path: devicePath,
      name: deviceName,
    });
  });

  stream.on("data", (chunk: Buffer | string) => {
    try {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "binary");
      remainder = remainder.length > 0 ? Buffer.concat([remainder, chunkBuffer]) : chunkBuffer;

      while (remainder.length >= INPUT_EVENT_SIZE_BYTES) {
        const frame = remainder.subarray(0, INPUT_EVENT_SIZE_BYTES);
        remainder = remainder.subarray(INPUT_EVENT_SIZE_BYTES);

        const parsed = parseInputEvent64(frame);
        if (parsed.type !== EV_KEY) {
          continue;
        }

        const action = actionByKeyCode.get(parsed.code);
        if (!action || !shouldHandleValue(action, parsed.value)) {
          continue;
        }

        logger.info("MEDIA_KEY", {
          code: parsed.code,
          action,
        });

        dispatchAction(action, options);
      }
    } catch (error) {
      logger.warn("MEDIA_KEY_PARSE_ERROR", {
        path: devicePath,
        name: deviceName,
        error: toError(error),
      });
    }
  });

  stream.on("error", (error) => {
    logger.warn("MEDIA_KEY_DEVICE_ERROR", {
      path: devicePath,
      name: deviceName,
      error: toError(error),
    });
  });

  stream.on("close", () => {
    if (remainder.length > 0) {
      logger.warn("MEDIA_KEY_PARTIAL_FRAME", {
        path: devicePath,
        name: deviceName,
        remainingBytes: remainder.length,
        expectedEventBytes: INPUT_EVENT_SIZE_BYTES,
      });
    }
  });

  return stream;
}

export function startMediaKeyListener(options: MediaKeyListenerOptions): () => void {
  if (process.platform !== "linux") {
    logger.warn("MEDIA_KEY_DISABLED", {
      reason: "unsupported_platform",
      platform: process.platform,
    });
    return () => {};
  }

  if (!fs.existsSync(DEV_INPUT_DIR)) {
    logger.warn("MEDIA_KEY_DISABLED", {
      reason: "dev_input_missing",
      path: DEV_INPUT_DIR,
    });
    return () => {};
  }

  let devicePaths: string[];
  try {
    devicePaths = listEventDevices();
  } catch (error) {
    logger.warn("MEDIA_KEY_DISABLED", {
      reason: "event_scan_failed",
      path: DEV_INPUT_DIR,
      error: toError(error),
    });
    return () => {};
  }

  if (devicePaths.length === 0) {
    logger.warn("MEDIA_KEY_DISABLED", {
      reason: "no_event_devices",
      path: DEV_INPUT_DIR,
    });
    return () => {};
  }

  const streams = devicePaths.map((devicePath) => openDevice(devicePath, options));

  logger.info("media_key_listener_start", {
    enabled: toBoolString(true),
    devices: streams.length,
  });

  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const stream of streams) {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
    logger.info("media_key_listener_stop", {
      enabled: toBoolString(false),
      devices: streams.length,
    });
  };
}
