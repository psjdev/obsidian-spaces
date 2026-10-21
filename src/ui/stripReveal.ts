import { CLS_STRIP_OPEN, CLS_STRIP_ZONE } from "../explorer/selectors";

export interface StripRevealDeps {
  pane: HTMLElement;
  strip: HTMLElement;
  /** Viewport x of the strip's right edge, read per call. */
  stripRight: () => number;
}

/**
 * Owns the open/closed state of a hidden left strip: the trigger zone, the
 * listeners and the open class.
 *
 * Nothing listens to the pointer's movement while the strip is closed. The
 * reveal comes from `mouseenter`; the `mousemove` watcher that decides when
 * to close exists only while the strip is open.
 */
export class StripReveal {
  private zone: HTMLElement | null = null;
  private doc: Document | null = null;
  private win: Window | null = null;
  private open = false;
  private held = false;

  private readonly onEnter = (): void => this.show();

  /**
   * A drag entering the zone or the strip. `dragenter` fires once per element
   * entry, so this is not per-pointer-move work. Holds, because a drag's
   * pointer must not close the strip under it; the owner releases at the
   * drag's end.
   */
  private readonly onDragEnter = (): void => this.hold();

  /** Overshooting past the edge and out of the window still reveals. */
  private readonly onDocLeave = (e: MouseEvent): void => {
    if (e.clientX <= this.deps.stripRight()) this.show();
  };

  private readonly onMove = (e: MouseEvent): void => {
    if (this.held) return;
    if (e.clientX > this.deps.stripRight()) this.hide();
  };

  constructor(private readonly deps: StripRevealDeps) {}

  /** Creates the zone and binds the open triggers. */
  attach(): void {
    if (this.zone) return;
    const { pane, strip } = this.deps;
    const doc = pane.ownerDocument;
    this.doc = doc;
    this.win = doc.defaultView;
    const zone = pane.createDiv({ cls: CLS_STRIP_ZONE });
    this.zone = zone;
    // The strip's visible lip paints above the zone, so a pointer slammed
    // into the screen edge lands on the strip. Both must open it.
    zone.addEventListener("mouseenter", this.onEnter);
    strip.addEventListener("mouseenter", this.onEnter);
    zone.addEventListener("dragenter", this.onDragEnter);
    strip.addEventListener("dragenter", this.onDragEnter);
    doc.addEventListener("mouseleave", this.onDocLeave);
  }

  /** Opens and holds open until `release()`, for drags. */
  hold(): void {
    this.held = true;
    this.show();
  }

  release(): void {
    this.held = false;
  }

  /** Removes every listener and the zone. Idempotent. */
  destroy(): void {
    this.unwatch();
    if (this.zone) {
      this.zone.removeEventListener("mouseenter", this.onEnter);
      this.zone.removeEventListener("dragenter", this.onDragEnter);
      this.zone.remove();
      this.zone = null;
    }
    this.deps.strip.removeEventListener("mouseenter", this.onEnter);
    this.deps.strip.removeEventListener("dragenter", this.onDragEnter);
    this.doc?.removeEventListener("mouseleave", this.onDocLeave);
    this.doc = null;
    this.win = null;
    this.held = false;
    if (this.open) {
      this.open = false;
      this.deps.pane.classList.remove(CLS_STRIP_OPEN);
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  private show(): void {
    if (this.open || !this.win) return;
    this.open = true;
    this.deps.pane.classList.add(CLS_STRIP_OPEN);
    this.win.addEventListener("mousemove", this.onMove);
  }

  private hide(): void {
    if (!this.open) return;
    this.open = false;
    this.deps.pane.classList.remove(CLS_STRIP_OPEN);
    this.unwatch();
  }

  private unwatch(): void {
    this.win?.removeEventListener("mousemove", this.onMove);
  }
}
