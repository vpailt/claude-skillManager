import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A scrollable area that says when it is cut off.
 *
 * A panel whose content runs past its bottom edge looks, at a glance, exactly
 * like one that ends there — the last row is simply sliced, and nothing tells
 * the reader to keep going. This fades the content out over the last few pixels
 * while there is more below (and above, once scrolled), so the boundary reads as
 * "continues" rather than "ends".
 *
 * The gradient is an overlay, not a `mask-image`: a mask would fade the final
 * rows *permanently*, including when the reader has reached the end and those
 * rows are the answer they came for. It is `pointer-events-none`, so it never
 * swallows a click on the row underneath.
 *
 * By default the component owns the scrolling (`overflow-y-auto` on its inner
 * div). Wrapping something that scrolls on its own — a Radix `ScrollArea`, say —
 * is the `wraps` mode: the fade then watches that element's viewport instead.
 */
export function ScrollFade({
  children,
  className,
  innerClassName,
  wraps = false,
  /** Height of the fade, in pixels. */
  size = 28,
}: {
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  wraps?: boolean;
  size?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  // The element that actually scrolls: this component's own div, or — when
  // wrapping a Radix ScrollArea — the viewport it renders inside.
  const findTarget = useCallback((): HTMLElement | null => {
    const host = hostRef.current;
    if (!host) return null;
    if (!wraps) return host.firstElementChild as HTMLElement | null;
    return host.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
  }, [wraps]);

  useEffect(() => {
    let target = findTarget();
    // A Radix viewport is mounted by the child, which may render a beat after
    // this effect; retry once on the next frame rather than giving up.
    let raf = 0;
    const measure = () => {
      if (!target) {
        target = findTarget();
        if (!target) return;
      }
      const { scrollTop, scrollHeight, clientHeight } = target;
      // 1 px of slack: fractional scroll heights are routine at non-integer
      // zoom levels, and would otherwise leave the fade on forever at the end.
      setEdges({
        top: scrollTop > 1,
        bottom: scrollTop + clientHeight < scrollHeight - 1,
      });
    };

    raf = requestAnimationFrame(measure);
    if (!target) {
      return () => cancelAnimationFrame(raf);
    }

    target.addEventListener("scroll", measure, { passive: true });
    // Both the viewport and its content: the first catches a resized window,
    // the second a list that grew or shrank without any scrolling at all.
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    if (target.firstElementChild) ro.observe(target.firstElementChild);

    return () => {
      cancelAnimationFrame(raf);
      target?.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [findTarget, children]);

  return (
    <div ref={hostRef} className={cn("relative min-h-0", className)}>
      {wraps ? (
        children
      ) : (
        <div className={cn("h-full overflow-y-auto", innerClassName)}>
          {children}
        </div>
      )}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-background to-transparent transition-opacity duration-150",
          edges.top ? "opacity-100" : "opacity-0"
        )}
        style={{ height: size }}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background to-transparent transition-opacity duration-150",
          edges.bottom ? "opacity-100" : "opacity-0"
        )}
        style={{ height: size }}
      />
    </div>
  );
}
