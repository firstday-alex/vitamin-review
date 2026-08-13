/**
 * <article-toc>
 *
 * Builds a table of contents from the headings already present in an article and
 * parks it in the page gutter beside the body copy.
 *
 * The list is generated client-side because article bodies are authored in the
 * rich-text editor, where headings rarely carry ids. Anything the element needs
 * that Liquid can't know — how much gutter the viewport actually has, which
 * heading the reader is next to — is measured here.
 *
 * Two layout modes, chosen by measurement rather than a breakpoint:
 *   rail   — fixed panel in the gutter next to the content column
 *   inline — normal-flow card directly above the body copy
 *
 * Data attributes (all optional, set by sections/article-toc-panel.liquid):
 *   data-content-selector  container to read headings from (default `.blog-post-content`)
 *   data-heading-selector  which headings to list (default `h2`)
 *   data-min-headings      hide the panel below this count (default 2)
 *   data-panel-width       rail width in px (default 320)
 *   data-side              `left` or `right` (default left)
 *   data-numbered          `true` to prefix 01, 02, …
 *   data-scroll-offset     px of sticky-header clearance when jumping to a heading
 *   data-hide-out-of-view  `true` to fade the rail out once the article scrolls past
 *
 * The rail is hidden until the body copy reaches it, so it never sits over
 * whatever is above the article (the blog hero, the title, the featured image).
 */

/** Minimum breathing room between the rail and the content column / viewport edge. */
const RAIL_MIN_GAP = 32;

/** Below this the rail is too cramped to read, so the panel goes inline instead. */
const RAIL_MIN_WIDTH = 220;

/** Extra clearance above a heading when scrolled to, on top of data-scroll-offset. */
const SCROLL_PADDING = 12;

class ArticleToc extends HTMLElement {
  /** @type {HTMLElement | null} */
  #content = null;

  /** Marks where the element started, so it can be put back if its host section reloads. */
  /** @type {Comment | null} */
  #anchor = null;

  /** True while this element is being moved, so disconnectedCallback can ignore the churn. */
  #moving = false;

  /** Guards the one retry for a body that hasn't been parsed yet. */
  #retried = false;

  /** @type {{ heading: HTMLElement, link: HTMLAnchorElement }[]} */
  #entries = [];

  /** @type {ResizeObserver | null} */
  #resizeObserver = null;

  #controller = new AbortController();

  /** @type {number | null} */
  #scrollFrame = null;

  connectedCallback() {
    // Relocating the panel re-runs this callback; the outer call owns the setup.
    if (this.#moving) return;

    this.#content = document.querySelector(this.#contentSelector);

    if (!this.#content) {
      this.dataset.mode = 'off';
      this.#retryWhenReady();
      return;
    }

    this.#retried = false;

    if (!this.#anchor) {
      this.#anchor = document.createComment('article-toc');
      this.before(this.#anchor);
    }

    this.#build();

    if (this.#entries.length < this.#minHeadings) {
      this.dataset.mode = 'off';
      return;
    }

    this.#relocate();
    this.#adoptRailItems();
    // Measure before wiring observers up, so the panel still lays out if any of
    // them are unavailable.
    this.#measure();
    this.#observe();
    this.#updateVisibility();
    this.#updateActive();
  }

  disconnectedCallback() {
    if (this.#moving) return;

    this.#teardown();

    // In the theme editor, re-rendering the blog post section wipes out whatever
    // was moved inside it — this element included. The anchor left behind in the
    // original section is still live, so climb back to it and rebuild.
    const anchor = this.#anchor;
    if (anchor?.isConnected) {
      requestAnimationFrame(() => {
        if (!this.isConnected && anchor.isConnected) anchor.after(this);
      });
    }
  }

  /**
   * The body copy may not be in the document yet if this element gets upgraded
   * early — the Section Rendering API and theme-editor re-renders can both do
   * that. Without this, one unlucky ordering would switch the panel off for the
   * rest of the page's life.
   */
  #retryWhenReady() {
    if (this.#retried) return;
    this.#retried = true;

    const retry = () => {
      if (this.isConnected && !this.#content) this.connectedCallback();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', retry, { once: true, signal: this.#controller.signal });
    } else {
      requestAnimationFrame(retry);
    }
  }

  get #contentSelector() {
    return this.dataset.contentSelector || '.blog-post-content';
  }

  get #headingSelector() {
    return this.dataset.headingSelector || 'h2';
  }

  get #minHeadings() {
    return Number(this.dataset.minHeadings) || 1;
  }

  get #panelWidth() {
    return Number(this.dataset.panelWidth) || 320;
  }

  get #scrollOffset() {
    return Number(this.dataset.scrollOffset) || 0;
  }

  /** @type {HTMLElement | null} */
  get #list() {
    return this.querySelector('[data-article-toc-list]');
  }

  /**
   * Reads the headings out of the article and renders the list.
   */
  #build() {
    const list = this.#list;
    if (!list || !this.#content) return;

    const headings = /** @type {HTMLElement[]} */ ([
      ...this.#content.querySelectorAll(this.#headingSelector),
    ]).filter((heading) => heading.textContent?.trim());

    this.#entries = [];
    list.textContent = '';

    headings.forEach((heading, index) => {
      const label = heading.textContent?.trim() ?? '';
      heading.id ||= this.#uniqueId(label, index);
      heading.style.scrollMarginBlockStart = `${this.#scrollOffset + SCROLL_PADDING}px`;

      const item = document.createElement('li');
      item.className = 'article-toc__item';

      const link = document.createElement('a');
      link.className = 'article-toc__link';
      link.href = `#${heading.id}`;

      if (this.dataset.numbered === 'true') {
        const number = document.createElement('span');
        number.className = 'article-toc__number';
        number.setAttribute('aria-hidden', 'true');
        number.textContent = String(index + 1).padStart(2, '0');
        link.append(number);
      }

      const text = document.createElement('span');
      text.className = 'article-toc__label';
      text.textContent = label;
      link.append(text);

      item.append(link);
      list.append(item);

      this.#entries.push({ heading, link });
    });
  }

  /**
   * Builds a slug that is unique on the page, falling back to the index for
   * headings that slugify to nothing (emoji-only, punctuation, etc.).
   * @param {string} label
   * @param {number} index
   * @returns {string}
   */
  #uniqueId(label, index) {
    const slug =
      label
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `section-${index + 1}`;

    let candidate = slug;
    let suffix = 2;
    while (document.getElementById(candidate)) {
      candidate = `${slug}-${suffix++}`;
    }

    return candidate;
  }

  /**
   * Moves the panel to sit immediately before the body copy. In rail mode the
   * panel is fixed so its position in the DOM doesn't matter; in inline mode
   * this is what puts the card above the article instead of below it.
   */
  #relocate() {
    const content = this.#content;
    if (!content?.parentNode || content.previousElementSibling === this) return;

    this.#moving = true;
    content.parentNode.insertBefore(this, content);
    this.#moving = false;
  }

  /**
   * Pulls other article-side modules (the editor's pick, for one) inside this
   * element so they share the rail's positioning and show/hide behaviour, rather
   * than each one re-deriving where the gutter is.
   *
   * Anything marked [data-article-rail-item] opts in; its data-rail-order
   * decides whether it lands above or below the contents list. Items are left
   * alone if there is no rail, so they still render as ordinary sections.
   */
  #adoptRailItems() {
    const items = document.querySelectorAll('[data-article-rail-item]');
    if (!items.length) return;

    this.#moving = true;

    for (const item of items) {
      if (item === this || this.contains(item)) continue;
      if (item.getAttribute('data-rail-order') === 'before') {
        this.prepend(item);
      } else {
        this.append(item);
      }
    }

    this.#moving = false;
  }

  #observe() {
    const { signal } = this.#controller;
    const content = this.#content;
    if (!content) return;

    window.addEventListener('scroll', this.#onScroll, { passive: true, signal });
    window.addEventListener('resize', this.#measure, { passive: true, signal });
    this.addEventListener('click', this.#onClick, { signal });

    // The window resize listener above covers the common case; this catches the
    // content column changing width on its own (font loading, editor edits).
    if ('ResizeObserver' in window) {
      this.#resizeObserver = new ResizeObserver(this.#measure);
      this.#resizeObserver.observe(content);
    }

  }

  #teardown() {
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#scrollFrame != null) cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = null;
  }

  /**
   * Picks rail vs inline from the space actually available beside the content
   * column, and pins the rail to the correct gutter.
   */
  #measure = () => {
    const content = this.#content;
    if (!content) return;

    const box = content.getBoundingClientRect();
    const gutter = (window.innerWidth - box.width) / 2;

    // Narrow the rail to fit rather than dropping straight to the inline card —
    // that keeps the side panel on ~1280px laptops, which the full width misses.
    const width = Math.min(this.#panelWidth, Math.floor(gutter - RAIL_MIN_GAP * 2));

    if (width >= RAIL_MIN_WIDTH) {
      const left = this.dataset.side === 'right' ? box.right + RAIL_MIN_GAP : box.left - RAIL_MIN_GAP - width;

      this.style.setProperty('--article-toc-rail-width', `${width}px`);
      this.style.setProperty('--article-toc-rail-left', `${Math.round(left)}px`);
      this.dataset.mode = 'rail';
    } else {
      this.style.removeProperty('--article-toc-rail-width');
      this.style.removeProperty('--article-toc-rail-left');
      this.dataset.mode = 'inline';
    }

    this.#updateVisibility();
  };

  #onScroll = () => {
    if (this.#scrollFrame != null) return;
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = null;
      this.#updateVisibility();
      this.#updateActive();
    });
  };

  /**
   * Shows the rail only while the body copy is actually alongside it.
   *
   * The panel is fixed to the viewport, so anything above the article — the blog
   * hero, most of all — shares that space. Keying off "is the article on screen
   * at all" pops the panel over the hero, because a tall article starts
   * intersecting long before its first line reaches the top of the screen.
   * Instead the panel waits until the copy has actually reached the panel's own
   * top edge, and leaves once the copy has passed above it.
   */
  #updateVisibility() {
    const content = this.#content;
    if (!content) return;

    // Inline mode sits in the page flow, where there is nothing to overlap.
    if (this.dataset.mode !== 'rail') {
      this.dataset.inView = 'true';
      return;
    }

    // Read the resolved `top` so the sticky-header offset is accounted for
    // without duplicating that calc here.
    const anchor = parseFloat(getComputedStyle(this).top) || 0;
    const rect = content.getBoundingClientRect();

    const reachedCopy = rect.top <= anchor;
    const pastCopy = this.dataset.hideOutOfView === 'true' && rect.bottom <= anchor;

    this.dataset.inView = reachedCopy && !pastCopy ? 'true' : 'false';
  }

  /**
   * Highlights the last heading the reader has scrolled past.
   */
  #updateActive() {
    if (!this.#entries.length) return;

    const threshold = this.#scrollOffset + SCROLL_PADDING + 4;
    let active = -1;

    this.#entries.forEach(({ heading }, index) => {
      if (heading.getBoundingClientRect().top <= threshold) active = index;
    });

    // Before the first heading, keep the first row lit rather than nothing.
    if (active < 0) active = 0;

    this.#entries.forEach(({ link }, index) => {
      const current = index === active;
      link.classList.toggle('article-toc__link--active', current);
      if (current) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  /**
   * Smooth-scrolls to a heading with sticky-header clearance, and records the
   * hash without letting the browser jump.
   * @param {MouseEvent} event
   */
  #onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const link = target.closest('.article-toc__link');
    if (!(link instanceof HTMLAnchorElement)) return;

    const id = decodeURIComponent(link.hash.slice(1));
    const heading = id ? document.getElementById(id) : null;
    if (!heading) return;

    event.preventDefault();

    const top = heading.getBoundingClientRect().top + window.scrollY - this.#scrollOffset - SCROLL_PADDING;

    window.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });

    history.replaceState(null, '', `#${heading.id}`);
  };
}

if (!customElements.get('article-toc')) {
  customElements.define('article-toc', ArticleToc);
}
