import { CLS_STRIP_OPEN, CLS_STRIP_ZONE } from "../explorer/selectors";

export interface StripRevealDeps {
  pane: HTMLElement;
  strip: HTMLElement;
  /**
   * Viewport x of the strip's right edge as it is painted right now, read per
   * call.
   *
   * Asked by the two leave paths, which run while the strip is closed, and
   * while it is closed the painted edge IS the lip's right edge. So the lip
   * width comes from the layout rather than from a second copy of the 6px in
   * `styles.css`.
   */
  lipRight: () => number;
  /**
   * Viewport x the strip's right edge settles at once it is fully open, read
   * per call.
   *
   * Asked by `onMove`, which runs while the strip is open and so possibly
   * mid-slide. A painted edge measured mid-slide is a number between the lip
   * and the full width, and comparing the pointer against it closed the strip
   * under a pointer that was well inside the strip's settled bounds.
   */
  openRight: () => number;
}

/**
 * Owns the open/closed state of a hidden left strip: the trigger zone, the
 * listeners and the open class.
 *
 * Nothing listens to the pointer's MOVEMENT while the strip is closed. All
 * four open paths are boundary events, one per element entry or exit: a
 * `mouseenter` on the zone or on the strip (while closed, the lip is the part
 * of the strip on screen), a `dragenter` on either of those two, and a
 * `mouseleave` of the document or of the pane with the pointer at or left of
 * the lip. The `mousemove` watcher that decides when to close is added in
 * `show()` and removed in `hide()`, so it runs only while this controller is
 * holding the strip open. A strip revealed by keyboard focus instead is
 * painted out by `styles.css` with no watcher attached, and blur is what
 * closes that one.
 */
export class StripReveal {
  private zone: HTMLElement | null = null;
  private doc: Document | null = null;
  private win: Window | null = null;
  private open = false;

  private readonly onEnter = (): void => this.show();

  /**
   * A drag entering the zone or the strip opens it. `dragenter` fires once per
   * element entry, so this is not per-pointer-move work.
   *
   * Nothing holds it open afterwards, and nothing has to: the browser fires no
   * `mousemove` during a native drag, only drag events, so the watcher that
   * would close the strip hears nothing until the drag is over. Counted in a
   * running Obsidian over one drag across the strip: 12 `dragover`, 0
   * `mousemove`. The grip is the one pointer drag that does fire `mousemove`,
   * and it never meets a hidden strip, because hiding is suspended for as long
   * as the strip is unlocked and the grip exists only while it is unlocked.
   */
  private readonly onDragEnter = (): void => this.show();

  /** Overshooting past the edge and out of the window still reveals. */
  private readonly onDocLeave = (e: MouseEvent): void => {
    if (e.clientX <= this.deps.lipRight()) this.show();
  };

  /**
   * Leaving the pane leftward reveals. With the ribbon visible the pane sits
   * right of the screen edge, so the trigger band is mid-screen and a fast
   * sweep can cross it without a `mousemove` landing inside, ending on the
   * ribbon. `mouseleave` is a boundary event (once per exit, no per-move
   * cost), so the ribbon becomes approach space. The test is the overshoot's:
   * `lipRight()` is the lip's right edge while closed, so the lip width
   * is read from the layout rather than copied from `styles.css`.
   */
  private readonly onPaneLeave = (e: MouseEvent): void => {
    if (e.clientX <= this.deps.lipRight()) this.show();
  };

  private readonly onMove = (e: MouseEvent): void => {
    // Against the SETTLED open edge, never the painted one: the reveal takes
    // 120ms, and `getBoundingClientRect().right` interpolates for all of it.
    if (e.clientX > this.deps.openRight()) this.hide();
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
    pane.addEventListener("mouseleave", this.onPaneLeave);
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
    this.deps.pane.removeEventListener("mouseleave", this.onPaneLeave);
    this.doc = null;
    this.win = null;
    if (this.open) {
      this.open = false;
      this.deps.pane.classList.remove(CLS_STRIP_OPEN);
    }
  }

  /** Opens without a pointer event: a rebuilt pane under a resting pointer. */
  reopen(): void {
    this.show();
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
