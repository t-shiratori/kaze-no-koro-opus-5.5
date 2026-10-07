import { damp } from "../core/math";

const MESSAGES = [
  "海図をひろげています",
  "島々を描いています",
  "雲を浮かべています",
  "風を待っています",
];

/**
 * The night horizon shown while the world is being built. The little flying boat
 * crosses it as the work progresses; when everything is ready the first light
 * swells along the horizon and the veil parts from there.
 */
export class Loader {
  private root = document.getElementById("veil");
  private text = document.getElementById("veil-text");
  private target = 0;
  private shown = 0;
  private msg = 0;
  private msgTimer = 2.8;
  private state: "loading" | "ready" | "open" = "loading";
  private wait = 0;

  /** Called once the veil starts to part: the moment the world should appear. */
  onOpen: () => void = () => {};

  get done(): boolean {
    return this.state === "open";
  }

  progress(p: number) {
    this.target = Math.max(this.target, Math.min(p, 1));
  }

  /** Skip the whole ceremony (dev). */
  dismiss() {
    this.state = "open";
    this.root?.remove();
    this.onOpen();
  }

  /** Advance the indicator; `ready` once the world can be shown. */
  update(dt: number, ready: boolean) {
    if (this.state === "open" || !this.root) return;
    if (ready) this.target = 1;
    this.shown = damp(this.shown, this.target, ready ? 4 : 2.2, dt);
    this.root.style.setProperty("--p", this.shown.toFixed(4));

    if (this.state === "loading") {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0 && this.text) this.cycleMessage();
      if (ready && this.shown > 0.985) {
        this.state = "ready";
        this.root.classList.add("ready");
        this.wait = 1.1;
      }
    } else if (this.state === "ready") {
      this.wait -= dt;
      if (this.wait <= 0) {
        this.state = "open";
        const root = this.root;
        root.classList.add("open");
        this.onOpen();
        setTimeout(() => root.remove(), 3600);
      }
    }
  }

  private cycleMessage() {
    const text = this.text!;
    this.msgTimer = 2.8;
    text.classList.add("out");
    setTimeout(() => {
      this.msg = (this.msg + 1) % MESSAGES.length;
      text.textContent = MESSAGES[this.msg];
      text.classList.remove("out");
    }, 900);
  }
}
