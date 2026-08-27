'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Content that settles into place when it arrives.
 *
 * Three rules, and they are what separate this from the version of this effect
 * that makes a site feel cheap.
 *
 * **It travels a few pixels, not a screen.** Fourteen. Content that flies in
 * from the edge reads as a slideshow; content that rises slightly reads as
 * paper settling onto a counter.
 *
 * **It happens once.** The observer disconnects on the first intersection.
 * Re-animating on every scroll past is how a page becomes exhausting to read.
 *
 * **It never hides content that failed to animate.** The starting state is
 * applied by the component after mount, so a browser with no IntersectionObserver,
 * a crawler, or a JavaScript failure all render the content plainly visible.
 * The alternative — hiding in CSS and revealing in JS — is a page that is blank
 * for anyone the script did not reach.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode
  /** Steps of one stagger unit, for items in a row. */
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'idle' | 'armed' | 'shown'>('idle')

  useEffect(() => {
    const element = ref.current
    if (!element) return

    // Honoured here rather than only in CSS: with reduced motion the element
    // should never enter a hidden state at all, not enter one and skip the
    // transition out of it.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || typeof IntersectionObserver === 'undefined') {
      setState('shown')
      return
    }

    setState('armed')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          setState('shown')
          observer.disconnect()
        }
      },
      // Fires a little before the element's top edge reaches the viewport, so
      // the movement has finished by the time it is properly in view.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={[className, 'reveal', state === 'armed' ? 'reveal--armed' : '']
        .filter(Boolean)
        .join(' ')}
      style={delay ? { transitionDelay: `calc(var(--stagger) * ${delay})` } : undefined}
    >
      {children}
    </div>
  )
}
