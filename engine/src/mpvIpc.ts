import fs from "node:fs";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { toError } from "./utils";

interface MpvResponse {
  request_id?: number;
  error?: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type PlaylistAdvanceMode = "force" | "weak";

export class MpvIpc {
  private socket?: net.Socket;
  private connectPromise?: Promise<net.Socket>;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private nextRequestId = 1;

  constructor(
    private readonly socketPath: string,
    private readonly requestTimeoutMs = 5_000,
  ) {}

  async waitForSocketReady(timeoutMs = 30_000, pollMs = 500): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (fs.existsSync(this.socketPath)) {
        try {
          await this.getProperty("idle-active");
          return;
        } catch {
          // mpv socket exists but might still be booting; continue polling
        }
      }

      await delay(pollMs);
    }

    throw new Error(`Timed out waiting for mpv socket ${this.socketPath}`);
  }

  async loadReplace(url: string): Promise<void> {
    await this.sendVoid(["loadfile", url, "replace"]);
  }

  async appendPlay(url: string): Promise<void> {
    await this.sendVoid(["loadfile", url, "append-play"]);
  }

  async playlistNext(force: boolean | PlaylistAdvanceMode = true): Promise<void> {
    const mode = this.resolveAdvanceMode(force);
    await this.sendVoid(["playlist-next", mode]);
  }

  async playlistPrev(force: boolean | PlaylistAdvanceMode = true): Promise<void> {
    const mode = this.resolveAdvanceMode(force);
    await this.sendVoid(["playlist-prev", mode]);
  }

  async togglePause(): Promise<void> {
    await this.sendVoid(["cycle", "pause"]);
  }

  async toggleMute(): Promise<void> {
    await this.sendVoid(["cycle", "mute"]);
  }

  async addVolume(delta: number): Promise<void> {
    await this.sendVoid(["add", "volume", delta]);
  }

  async getProperty<T = unknown>(name: string): Promise<T> {
    const result = await this.sendCommand(["get_property", name]);
    return result as T;
  }

  async setProperty(name: string, value: unknown): Promise<void> {
    await this.sendVoid(["set_property", name, value]);
  }

  async showOsd(text: string, durationMs = 5000): Promise<void> {
    await this.sendVoid(["show-text", text, durationMs]);
  }

  async removePlaylistIndex(index: number): Promise<void> {
    await this.sendVoid(["playlist-remove", index]);
  }

  close(): void {
    this.disconnect(new Error("mpv connection closed by engine"));
  }

  private async sendVoid(command: unknown[]): Promise<void> {
    await this.sendCommand(command);
  }

  private resolveAdvanceMode(force: boolean | PlaylistAdvanceMode): PlaylistAdvanceMode {
    if (force === "force" || force === "weak") {
      return force;
    }
    return force ? "force" : "weak";
  }

  private async sendCommand(command: unknown[], retry = true): Promise<unknown> {
    try {
      return await this.sendCommandOnce(command);
    } catch (error) {
      const err = toError(error);

      if (!retry || err.message.startsWith("mpv command failed:")) {
        throw err;
      }

      this.disconnect(new Error("Reset mpv IPC socket after request failure"));
      await delay(200);
      return this.sendCommand(command, false);
    }
  }

  private async sendCommandOnce(command: unknown[]): Promise<unknown> {
    const socket = await this.ensureConnected();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const payload = JSON.stringify({ command, request_id: requestId }) + "\n";

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for mpv response (request ${requestId})`));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout });

      socket.write(payload, "utf8", (error?: Error | null) => {
        if (!error) {
          return;
        }

        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private async ensureConnected(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.openSocket().finally(() => {
        this.connectPromise = undefined;
      });
    }

    return this.connectPromise;
  }

  private openSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);

      const onConnect = () => {
        cleanupBootstrapListeners();
        this.attachRuntimeListeners(socket);
        resolve(socket);
      };

      const onBootstrapError = (error: Error) => {
        cleanupBootstrapListeners();
        socket.destroy();
        reject(error);
      };

      const cleanupBootstrapListeners = () => {
        socket.off("connect", onConnect);
        socket.off("error", onBootstrapError);
      };

      socket.setEncoding("utf8");
      socket.once("connect", onConnect);
      socket.once("error", onBootstrapError);
    });
  }

  private attachRuntimeListeners(socket: net.Socket): void {
    this.socket = socket;

    socket.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.onData(text);
    });

    socket.on("error", (error) => {
      this.disconnect(new Error(`mpv socket error: ${error.message}`));
    });

    socket.on("close", () => {
      this.disconnect(new Error("mpv socket closed"));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.handleLine(line);
      }

      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: MpvResponse;
    try {
      message = JSON.parse(line) as MpvResponse;
    } catch {
      return;
    }

    if (typeof message.request_id !== "number") {
      return;
    }

    const pending = this.pending.get(message.request_id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.request_id);

    if (message.error && message.error !== "success") {
      pending.reject(new Error(`mpv command failed: ${message.error}`));
      return;
    }

    pending.resolve(message.data);
  }

  private disconnect(reason: Error): void {
    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      if (!socket.destroyed) {
        socket.destroy();
      }
    }

    this.buffer = "";

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
