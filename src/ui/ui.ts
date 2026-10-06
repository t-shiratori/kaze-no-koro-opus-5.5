import type { TimeMode, TimeOfDay } from "../env/time";
import type { CameraMode, Director } from "../flight/director";

const CAMERA_LABELS: [CameraMode, string][] = [
  ["calm", "標準"],
  ["cinema", "シネマ"],
];

const LABELS: [TimeMode, string, string][] = [
  ["auto", "移ろい", "0"],
  ["morning", "朝", "1"],
  ["noon", "昼", "2"],
  ["rays", "光芒", "3"],
  ["evening", "夕", "4"],
  ["night", "夜", "5"],
];

/** A quiet, auto-hiding control strip. The world is the interface. */
export class UI {
  private root: HTMLDivElement;
  private buttons = new Map<TimeMode, HTMLButtonElement>();
  private camButtons = new Map<CameraMode, HTMLButtonElement>();
  private clock: HTMLSpanElement;
  private hideTimer = 0;
  private hidden = false;

  constructor(
    private time: TimeOfDay,
    private director: Director,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ui";
    const group = document.createElement("div");
    group.className = "ui-group";
    for (const [mode, label, key] of LABELS) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = `${label} (${key})`;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.time.setMode(mode);
        this.refresh();
      });
      this.buttons.set(mode, b);
      group.appendChild(b);
    }
    this.clock = document.createElement("span");
    this.clock.className = "ui-clock";
    const fs = document.createElement("button");
    fs.className = "ui-fs";
    fs.title = "全画面 (F)";
    fs.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`;
    fs.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });
    // camera: calm follow or film-style auto direction
    const camGroup = document.createElement("div");
    camGroup.className = "ui-group";
    for (const [mode, label] of CAMERA_LABELS) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = `カメラ: ${label} (C)`;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setCamera(mode);
      });
      this.camButtons.set(mode, b);
      camGroup.appendChild(b);
    }
    // letterbox bars for the cinema mode
    for (const pos of ["top", "bottom"]) {
      const bar = document.createElement("div");
      bar.className = `letterbox ${pos}`;
      document.body.appendChild(bar);
    }
    this.root.append(group, camGroup, this.clock, fs);
    document.body.appendChild(this.root);

    const wake = () => {
      this.root.classList.add("visible");
      clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.root.classList.remove("visible"), 2600);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", (e) => {
      const hit = LABELS.find(([, , k]) => k === e.key);
      if (hit) {
        this.time.setMode(hit[0]);
        this.refresh();
        wake();
      } else if (e.key === "c" || e.key === "C") {
        this.setCamera(this.director.mode === "cinema" ? "calm" : "cinema");
        wake();
      } else if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
      } else if (e.key === "h" || e.key === "H") {
        this.hidden = !this.hidden;
        this.root.style.display = this.hidden ? "none" : "";
      }
    });
    this.refresh();
  }

  private setCamera(mode: CameraMode) {
    this.director.setMode(mode);
    document.body.classList.toggle("cinema", mode === "cinema");
    this.refresh();
  }

  private refresh() {
    for (const [m, b] of this.buttons) b.classList.toggle("active", m === this.time.mode);
    for (const [m, b] of this.camButtons) b.classList.toggle("active", m === this.director.mode);
  }

  update() {
    const h = Math.floor(this.time.hours);
    const m = Math.floor((this.time.hours - h) * 60);
    const txt = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    if (this.clock.textContent !== txt) this.clock.textContent = txt;
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}
