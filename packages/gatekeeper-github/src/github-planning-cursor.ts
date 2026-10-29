import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { Cursor } from "./types";
import type { PlanningPage } from "./github-planning";

/** A bounded remote cursor: fetch and authorize a page before advancing past it. */
@validateRpc()
export class PlanningCursor<T> extends RpcTarget implements Cursor<T> {
  #after?: string;
  #done = false;
  #disposed = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly read: (after?: string) => Promise<PlanningPage<T>>,
    private readonly dispose: () => void,
  ) { super(); }

  next(): Promise<T[] | null> {
    const result = this.#tail.then(async () => {
      if (this.#disposed) throw new Error("This cursor has been disposed.");
      if (this.#done) return null;
      const page = await this.read(this.#after);
      this.#after = page.next;
      this.#done = page.next === undefined;
      return page.items;
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.dispose();
  }
}
