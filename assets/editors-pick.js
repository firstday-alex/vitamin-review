/**
 * <editors-pick>
 *
 * A small product carousel for the article rail. Built on native scroll-snap:
 * the arrows and dots drive `scrollTo`, and the active dot is derived from
 * `scrollLeft`. That keeps swipe, keyboard and mouse-wheel behaviour native, and
 * leaves the slides readable if this script never runs.
 *
 * Data attributes (set by sections/article-editors-pick.liquid):
 *   data-loop  `true` to wrap around at either end
 */
class EditorsPick extends HTMLElement {
  #controller = new AbortController();

  /** @type {number | null} */
  #frame = null;

  /** @type {ResizeObserver | null} */
  #resizeObserver = null;

  connectedCallback() {
    const { signal } = this.#controller;
    const viewport = this.#viewport;
    if (!viewport) return;

    // One slide needs no controls at all.
    this.dataset.controls = this.#slides.length > 1 ? 'true' : 'false';
    if (this.#slides.length < 2) return;

    this.#buildDots();

    viewport.addEventListener('scroll', this.#onScroll, { passive: true, signal });
    this.addEventListener('click', this.#onClick, { signal });

    if ('ResizeObserver' in window) {
      this.#resizeObserver = new ResizeObserver(this.#sync);
      this.#resizeObserver.observe(viewport);
    }

    this.#sync();
  }

  disconnectedCallback() {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#frame != null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  /** @type {HTMLElement | null} */
  get #viewport() {
    return this.querySelector('[data-epick-viewport]');
  }

  /** @type {HTMLElement | null} */
  get #dots() {
    return this.querySelector('[data-epick-dots]');
  }

  /** @type {HTMLElement[]} */
  get #slides() {
    return /** @type {HTMLElement[]} */ ([...this.querySelectorAll('[data-epick-slide]')]);
  }

  get #loop() {
    return this.dataset.loop === 'true';
  }

  /** Index nearest the current scroll offset. */
  get #index() {
    const viewport = this.#viewport;
    const slides = this.#slides;
    if (!viewport || !slides.length) return 0;

    const left = viewport.scrollLeft;
    let best = 0;
    let bestGap = Infinity;

    slides.forEach((slide, i) => {
      const gap = Math.abs(slide.offsetLeft - viewport.offsetLeft - left);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });

    return best;
  }

  #buildDots() {
    const dots = this.#dots;
    if (!dots) return;

    dots.textContent = '';

    this.#slides.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'epick__dot';
      dot.dataset.epickDot = String(i);
      dot.setAttribute('aria-label', `${i + 1}`);
      dots.append(dot);
    });
  }

  /**
   * @param {number} index
   */
  #goTo(index) {
    const viewport = this.#viewport;
    const slides = this.#slides;
    if (!viewport || !slides.length) return;

    const last = slides.length - 1;
    const target = this.#loop
      ? (index + slides.length) % slides.length
      : Math.min(last, Math.max(0, index));

    const slide = slides[target];
    if (!slide) return;

    viewport.scrollTo({
      left: slide.offsetLeft - viewport.offsetLeft,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  /**
   * @param {MouseEvent} event
   */
  #onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const dot = target.closest('[data-epick-dot]');
    if (dot instanceof HTMLElement) {
      this.#goTo(Number(dot.dataset.epickDot));
      return;
    }

    const arrow = target.closest('[data-epick-arrow]');
    if (arrow instanceof HTMLElement) {
      this.#goTo(this.#index + (arrow.dataset.epickArrow === 'next' ? 1 : -1));
    }
  };

  #onScroll = () => {
    if (this.#frame != null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#sync();
    });
  };

  /** Reflects the current slide onto the dots and the arrow disabled states. */
  #sync = () => {
    const index = this.#index;
    const last = this.#slides.length - 1;

    this.querySelectorAll('[data-epick-dot]').forEach((dot, i) => {
      const current = i === index;
      dot.classList.toggle('epick__dot--active', current);
      dot.setAttribute('aria-current', current ? 'true' : 'false');
    });

    this.#slides.forEach((slide, i) => {
      // Keep off-screen slides out of the tab order and the a11y tree.
      slide.toggleAttribute('inert', i !== index);
      slide.setAttribute('aria-hidden', i === index ? 'false' : 'true');
    });

    if (!this.#loop) {
      this.querySelectorAll('[data-epick-arrow]').forEach((arrow) => {
        const isNext = /** @type {HTMLElement} */ (arrow).dataset.epickArrow === 'next';
        /** @type {HTMLButtonElement} */ (arrow).disabled = isNext ? index >= last : index <= 0;
      });
    }
  };
}

if (!customElements.get('editors-pick')) {
  customElements.define('editors-pick', EditorsPick);
}
