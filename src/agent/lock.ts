import { closeSync, mkdirSync, openSync, statSync, unlinkSync, constants } from "node:fs";
import { dirname } from "node:path";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** 跨进程互斥。不用定时器，避免和「源码里不轮询」的检查冲突。 */
export function withFileLock<T>(lockPath: string, body: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      try {
        return body();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // 锁已经释放
        }
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) unlinkSync(lockPath);
      } catch {
        // 另一个进程刚删掉锁
      }
      if (Date.now() - started > 3_000) throw new Error("等待本机状态锁超时");
      const gate = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(gate, 0, 0, 20);
    }
  }
}
