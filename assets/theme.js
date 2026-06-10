document.addEventListener('DOMContentLoaded', () => {
  const recentStorageKey = 'buy-that-thing:recently-viewed';
  const listingContextKey = 'buy-that-thing:listing-context';
  const listingRestoreKey = 'buy-that-thing:listing-restore';
  const pageType = document.body?.dataset.pageType || '';
  const siteMoneyFormat = document.body?.dataset.moneyFormat || document.querySelector('[data-recently-viewed]')?.dataset.moneyFormat || '${{amount}}';
  const escapeHtml = (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const debounce = (callback, delay) => {
    let timeoutId = null;

    return (...args) => {
      if (timeoutId) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => callback(...args), delay);
    };
  };

  const getSearchMoneyFormat = () => {
    return siteMoneyFormat;
  };

  const buildPredictiveSearchMarkup = ({ query, queries = [], collections = [], products = [] }) => {
    const moneyFormat = getSearchMoneyFormat();
    const hasResults = queries.length > 0 || collections.length > 0 || products.length > 0;

    if (!hasResults) {
      return `
        <div class="predictive-search">
          <div class="predictive-search__empty">
            <p>No close matches for “${escapeHtml(query)}” yet.</p>
            <a class="predictive-search__all" href="/search?q=${encodeURIComponent(query)}">Search the full store instead</a>
          </div>
        </div>
      `;
    }

    const queryMarkup =
      queries.length > 0
        ? `
          <section class="predictive-search__group" aria-label="Suggested searches">
            <p class="predictive-search__heading">Suggested searches</p>
            <div class="predictive-search__list predictive-search__list--compact">
              ${queries
                .map((item) => {
                  const queryUrl = item.url || `/search?q=${encodeURIComponent(item.text || query)}`;
                  const queryText = item.styled_text || escapeHtml(item.text || '');
                  return `
                    <a class="predictive-search__item predictive-search__item--query" href="${escapeHtml(queryUrl)}" data-predictive-search-link>
                      <span class="predictive-search__query-text">${queryText}</span>
                    </a>
                  `;
                })
                .join('')}
            </div>
          </section>
        `
        : '';

    const collectionMarkup =
      collections.length > 0
        ? `
          <section class="predictive-search__group" aria-label="Collections">
            <p class="predictive-search__heading">Collections</p>
            <div class="predictive-search__list predictive-search__list--compact">
              ${collections
                .map(
                  (collection) => `
                    <a class="predictive-search__item predictive-search__item--collection" href="${escapeHtml(collection.url || '#')}" data-predictive-search-link>
                      <span class="predictive-search__item-title">${escapeHtml(collection.title || '')}</span>
                      <span class="predictive-search__item-meta">Browse collection</span>
                    </a>
                  `
                )
                .join('')}
            </div>
          </section>
        `
        : '';

    const productMarkup =
      products.length > 0
        ? `
          <section class="predictive-search__group" aria-label="Products">
            <p class="predictive-search__heading">Products</p>
            <div class="predictive-search__list">
              ${products
                .map((product) => {
                  const imageUrl = product.featured_image?.url || product.image || '';
                  const vendor = product.vendor ? escapeHtml(product.vendor) : '';
                  const price =
                    typeof product.price === 'number' ? formatMoneyValue(product.price, moneyFormat) : '';
                  const metaParts = [vendor, price].filter(Boolean);

                  return `
                    <a class="predictive-search__item predictive-search__item--product" href="${escapeHtml(product.url || '#')}" data-predictive-search-link>
                      <span class="predictive-search__thumb">
                        ${
                          imageUrl
                            ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.title || '')}" loading="lazy">`
                            : '<span class="predictive-search__thumb-placeholder" aria-hidden="true"></span>'
                        }
                      </span>
                      <span class="predictive-search__copy">
                        <span class="predictive-search__item-title">${escapeHtml(product.title || '')}</span>
                        ${
                          metaParts.length > 0
                            ? `<span class="predictive-search__item-meta">${metaParts.join('<span aria-hidden="true">·</span>')}</span>`
                            : ''
                        }
                      </span>
                    </a>
                  `;
                })
                .join('')}
            </div>
          </section>
        `
        : '';

    return `
      <div class="predictive-search">
        <div class="predictive-search__groups">
          ${queryMarkup}
          ${collectionMarkup}
          ${productMarkup}
        </div>
        <div class="predictive-search__footer">
          <a class="predictive-search__all" href="/search?q=${encodeURIComponent(query)}">
            View all results for “${escapeHtml(query)}”
          </a>
        </div>
      </div>
    `;
  };

  const normalizeDescriptionText = (root) => {
    const clone = root.cloneNode(true);

    clone.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));

    return clone.textContent
      .replace(/\r/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  const splitLabelSegments = (text) => {
    const normalized = text
      .replace(/\s*-\s*([A-Z][A-Z\s&/()'-]{2,}:)/g, '\n$1')
      .replace(/\s*([A-Z][A-Z\s&/()'-]{2,}:)/g, '\n$1')
      .replace(/^\n+/, '');

    return normalized
      .split(/\n+/)
      .map((segment) => segment.trim().replace(/^-\s*/, ''))
      .filter(Boolean);
  };

  const isTitleLikeSegment = (segment) => {
    const normalized = segment.replace(/^["'-\s]+|["'\s]+$/g, '').trim();
    if (!normalized) return false;

    const words = normalized.split(/\s+/);
    const hasDescriptionWord = /description:?/i.test(normalized);
    const longTitleShape = words.length >= 6 && normalized.length > 45;

    return hasDescriptionWord || longTitleShape;
  };

  const formatSegment = (segment, tagName = 'p') => {
    const colonIndex = segment.indexOf(':');
    const hasShortLabel = colonIndex > 1 && colonIndex < 40;

    if (!hasShortLabel) return `<${tagName}>${escapeHtml(segment)}</${tagName}>`;

    const label = segment.slice(0, colonIndex + 1).trim();
    const body = segment.slice(colonIndex + 1).trim();
    return `<${tagName}><strong>${escapeHtml(label)}</strong>${body ? ` ${escapeHtml(body)}` : ''}</${tagName}>`;
  };

  const buildImportedDescriptionMarkup = (root, { summary = false } = {}) => {
    if (!root) return null;

    const rawHtml = root.innerHTML.trim();
    const rawText = normalizeDescriptionText(root);
    const hasStructuredMarkup = /<(p|ul|ol|li|table|h[1-6]|details)\b/i.test(rawHtml);

    if (hasStructuredMarkup || !rawText) return null;

    let workingText = rawText;
    const descriptionIndex = workingText.search(/\bDescription:\s*/i);

    if (descriptionIndex > 40) {
      workingText = workingText.slice(descriptionIndex + workingText.match(/\bDescription:\s*/i)[0].length).trim();
    }

    workingText = workingText.replace(/^[-–—•\s"']+/, '').trim();

    const lineSegments = workingText
      .split(/\n+/)
      .map((segment) => segment.trim())
      .filter(Boolean);

    const dashSegments = workingText
      .split(/\s+-\s+/)
      .map((segment) => segment.trim())
      .filter(Boolean);

    const labelMatches = workingText.match(/(?:^|[.!?]\s*|\n+)([A-Z][A-Z\s&/()'-]{2,}:)/g) || [];
    const labelSegments = splitLabelSegments(workingText);

    let mode = null;
    let segments = [];

    if (lineSegments.length >= 3) {
      mode = 'lines';
      segments = lineSegments;
    } else if (dashSegments.length >= 3) {
      mode = 'dashes';
      segments = dashSegments;
    } else if (labelMatches.length >= 2 && labelSegments.length >= 2) {
      mode = 'labels';
      segments = labelSegments;
    } else {
      return null;
    }

    if (segments.length < 2) return null;

    if (summary) {
      const previewSegments = segments.filter((segment, index) => !(index === 0 && isTitleLikeSegment(segment)));
      const selectedSegments = (previewSegments.length > 0 ? previewSegments : segments).slice(0, 2);

      if (selectedSegments.length === 1 && mode === 'labels') {
        return {
          html: formatSegment(selectedSegments[0], 'p'),
          formattedClass: 'product-description-summary--formatted'
        };
      } else {
        return {
          html: `<ul>${selectedSegments.map((segment) => formatSegment(segment, 'li')).join('')}</ul>`,
          formattedClass: 'product-description-summary--formatted'
        };
      }
    }

    if (mode === 'lines' || mode === 'dashes') {
      return {
        html: `<ul>${segments.map((segment) => formatSegment(segment, 'li')).join('')}</ul>`,
        formattedClass: 'product-description-richtext--formatted'
      };
    } else {
      return {
        html: segments.map((segment) => formatSegment(segment, 'p')).join(''),
        formattedClass: 'product-description-richtext--formatted'
      };
    }
  };

  const formatImportedDescription = (root, options = {}) => {
    const formatted = buildImportedDescriptionMarkup(root, options);
    if (!formatted) return false;

    root.innerHTML = formatted.html;
    root.classList.add(formatted.formattedClass);
    return true;
  };

  const shuffleArray = (items) => {
    const clone = [...items];

    for (let index = clone.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [clone[index], clone[swapIndex]] = [clone[swapIndex], clone[index]];
    }

    return clone;
  };

  const readRecentlyViewed = () => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(recentStorageKey) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  };

  const writeRecentlyViewed = (items) => {
    try {
      window.localStorage.setItem(recentStorageKey, JSON.stringify(items));
    } catch (error) {
      return;
    }
  };

  const readSessionJson = (key) => {
    try {
      const value = window.sessionStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  };

  const writeSessionJson = (key, value) => {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      return;
    }
  };

  const removeSessionValue = (key) => {
    try {
      window.sessionStorage.removeItem(key);
    } catch (error) {
      return;
    }
  };

  const getListingSourceType = () => {
    if (pageType === 'search') return 'search';
    if (pageType === 'collection') return 'collection';
    return null;
  };

  const normalizePageUrl = (url) => {
    try {
      const parsed = new URL(url, window.location.origin);
      return `${parsed.pathname}${parsed.search}`;
    } catch (error) {
      return '';
    }
  };

  const isSearchReturnUrl = (url) => {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.pathname === '/search';
    } catch (error) {
      return false;
    }
  };

  const formatMoneyValue = (cents, moneyFormat = siteMoneyFormat) => {
    const value = (Number(cents) / 100).toFixed(2);
    return moneyFormat.replace(/\{\{\s*amount\s*\}\}/, value);
  };

  const buildRecentlyViewedCard = (product, moneyFormat) => {
    const compareAtHtml =
      product.compareAtPrice && product.compareAtPrice > product.price
        ? `<span class="price__compare">${formatMoneyValue(product.compareAtPrice, moneyFormat)}</span>`
        : '';
    const vendorHtml = product.vendor
      ? `<p class="product-card__vendor">${escapeHtml(product.vendor)}</p>`
      : '';
    const imageHtml = product.image
      ? `<img class="product-card__image" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" loading="lazy">`
      : '';
    const availabilityLabel = product.available ? 'View product' : 'Currently unavailable';

    return `
      <article class="product-card product-card--compact">
        <a class="product-card__image-link" href="${escapeHtml(product.url)}">
          ${imageHtml}
        </a>
        <div class="product-card__content">
          <div class="variant-preview variant-preview--empty" aria-hidden="true"></div>
          <div class="product-card__header">
            ${vendorHtml}
            <h3><a href="${escapeHtml(product.url)}">${escapeHtml(product.title)}</a></h3>
          </div>
          <div class="product-card__rating product-card__rating--empty" aria-hidden="true"></div>
          <div class="product-card__price">
            <div class="price">
              <span class="price__current">${formatMoneyValue(product.price, moneyFormat)}</span>
              ${compareAtHtml}
            </div>
          </div>
          <div class="delivery-lines">
            <span>Recently viewed</span>
            <strong>${availabilityLabel}</strong>
          </div>
          <a class="product-card__basket" href="${escapeHtml(product.url)}">View item</a>
        </div>
      </article>
    `;
  };

  const recentlyViewedRoot = document.querySelector('[data-recently-viewed]');
  if (recentlyViewedRoot) {
    const recentlyViewedGrid = recentlyViewedRoot.querySelector('[data-recently-viewed-grid]');
    const currentProductHandle = recentlyViewedRoot.dataset.currentProductHandle;
    const moneyFormat = recentlyViewedRoot.dataset.moneyFormat || '${{amount}}';
    const recentItems = readRecentlyViewed()
      .filter((item) => item && item.handle && item.url && item.title)
      .filter((item) => item.handle !== currentProductHandle)
      .slice(0, 4);

    if (recentlyViewedGrid && recentItems.length > 0) {
      recentlyViewedGrid.innerHTML = recentItems
        .map((item) => buildRecentlyViewedCard(item, moneyFormat))
        .join('');
      recentlyViewedRoot.hidden = false;
    }
  }

  const listingSourceType = getListingSourceType();
  if (listingSourceType) {
    document.querySelectorAll('[data-product-link]').forEach((link) => {
      link.addEventListener('click', (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        const productCard = link.closest('[data-product-handle]');
        const productHandle = productCard?.dataset.productHandle;
        if (!productHandle) return;

        if (listingSourceType === 'search') {
          event.preventDefault();
          const destinationUrl = new URL(link.href, window.location.origin);
          destinationUrl.searchParams.set('bt_source', 'search');
          destinationUrl.searchParams.set('bt_return', `${window.location.pathname}${window.location.search}`);
          destinationUrl.searchParams.set('bt_handle', productHandle);

          writeSessionJson(listingContextKey, {
            sourceType: listingSourceType,
            url: `${window.location.pathname}${window.location.search}`,
            productHandle,
            timestamp: Date.now()
          });

          window.location.href = `${destinationUrl.pathname}${destinationUrl.search}${destinationUrl.hash}`;
          return;
        }

        writeSessionJson(listingContextKey, {
          sourceType: listingSourceType,
          url: `${window.location.pathname}${window.location.search}`,
          productHandle,
          timestamp: Date.now()
        });
      });
    });

    const pendingRestore = readSessionJson(listingRestoreKey);
    if (pendingRestore && normalizePageUrl(pendingRestore.url) === normalizePageUrl(window.location.href)) {
      const targetCard = document.querySelector(`[data-product-handle="${pendingRestore.productHandle}"]`);
      if (targetCard) {
        window.requestAnimationFrame(() => {
          targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetCard.classList.add('product-card--restored');
          window.setTimeout(() => {
            targetCard.classList.remove('product-card--restored');
          }, 2200);
        });
      }
      removeSessionValue(listingRestoreKey);
    }
  }

  document.querySelectorAll('.product-card[data-product-handle]').forEach((card) => {
    const variantsNode = card.querySelector('[data-card-variants]');
    const variantSelect = card.querySelector('[data-card-variant-select]');
    const optionButtons = Array.from(card.querySelectorAll('[data-card-option-value]'));
    const image = card.querySelector('[data-card-image]');
    const imageLink = card.querySelector('.product-card__image-link');
    const priceRoot = card.querySelector('.product-card__price');
    const addToCart = card.querySelector('[data-card-add-to-cart]');

    if (!variantsNode || !variantSelect || !priceRoot) return;

    let variants = [];
    try {
      variants = JSON.parse(variantsNode.textContent);
    } catch (error) {
      return;
    }

    if (!Array.isArray(variants) || variants.length === 0) return;

    const findVariantById = (variantId) =>
      variants.find((variant) => String(variant.id) === String(variantId));

    const updateBadge = (variant) => {
      const currentBadge = card.querySelector('[data-card-badge]');
      const savings = Number(variant.compare_at_price || 0) - Number(variant.price || 0);
      if (savings > 0) {
        const badgeText = `Save ${formatMoneyValue(savings, siteMoneyFormat)}`;
        if (currentBadge) {
          currentBadge.textContent = badgeText;
        } else if (imageLink) {
          imageLink.insertAdjacentHTML('beforeend', `<span class="product-badge" data-card-badge>${badgeText}</span>`);
        }
      } else if (currentBadge) {
        currentBadge.remove();
      }
    };

    const updateOptionButtons = (variant) => {
      optionButtons.forEach((button) => {
        const isActive = button.dataset.cardOptionValue === variant.option1;
        button.classList.toggle('is-active', isActive);
      });
    };

    const syncCard = (variant) => {
      if (!variant) return;

      if (image && variant.featured_image) {
        image.src = variant.featured_image;
        image.removeAttribute('srcset');
        image.alt = variant.title || image.alt;
      }

      if (priceRoot) {
        if (variant.compare_at_price && variant.compare_at_price > variant.price) {
          priceRoot.innerHTML = `<div class="price"><span class="price__current">${formatMoneyValue(variant.price, siteMoneyFormat)}</span><span class="price__compare">${formatMoneyValue(variant.compare_at_price, siteMoneyFormat)}</span></div>`;
        } else {
          priceRoot.innerHTML = `<div class="price"><span class="price__current">${formatMoneyValue(variant.price, siteMoneyFormat)}</span></div>`;
        }
      }

      updateBadge(variant);
      updateOptionButtons(variant);

      if (variantSelect.tagName === 'SELECT') {
        variantSelect.value = String(variant.id);
      } else {
        variantSelect.value = String(variant.id);
      }

      if (addToCart) {
        addToCart.disabled = !variant.available;
        addToCart.textContent = variant.available ? 'Add to basket' : 'Sold out';
      }
    };

    if (variantSelect.tagName === 'SELECT') {
      variantSelect.addEventListener('change', () => {
        syncCard(findVariantById(variantSelect.value));
      });
    }

    optionButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const exactAvailableMatch = variants.find(
          (variant) => variant.option1 === button.dataset.cardOptionValue && variant.available
        );
        const exactMatch = variants.find((variant) => variant.option1 === button.dataset.cardOptionValue);
        syncCard(exactAvailableMatch || exactMatch || variants[0]);
      });
    });
  });

  const summaryRoot = document.querySelector('[data-product-description-summary]');
  const summarySource = document.querySelector('[data-product-description-source]');
  const summaryToggle = document.querySelector('[data-product-description-toggle]');
  let summaryExpanded = false;
  let summaryCollapsedHtml = '';
  let summaryExpandedHtml = '';

  if (summaryRoot && summarySource) {
    const formattedSummary = buildImportedDescriptionMarkup(summarySource, { summary: true });
    const formattedFull = buildImportedDescriptionMarkup(summarySource, { summary: false });
    const fallbackText = normalizeDescriptionText(summarySource).replace(/\s+/g, ' ').trim();

    if (formattedSummary) {
      summaryCollapsedHtml = formattedSummary.html;
      summaryRoot.classList.add(formattedSummary.formattedClass);
    } else {
      const shortened = fallbackText.split(/\s+/).slice(0, 28).join(' ');
      summaryCollapsedHtml = `<p>${escapeHtml(shortened)}${shortened.length < fallbackText.length ? '...' : ''}</p>`;
    }

    if (formattedFull) {
      summaryExpandedHtml = formattedFull.html;
    } else {
      summaryExpandedHtml = `<p>${escapeHtml(fallbackText)}</p>`;
    }

    summaryRoot.innerHTML = summaryCollapsedHtml;

    if (summaryToggle && summaryCollapsedHtml !== summaryExpandedHtml) {
      summaryToggle.classList.remove('is-hidden');
      summaryToggle.addEventListener('click', () => {
        summaryExpanded = !summaryExpanded;
        summaryRoot.innerHTML = summaryExpanded ? summaryExpandedHtml : summaryCollapsedHtml;
        summaryToggle.textContent = summaryExpanded ? 'Show less' : 'Read more';
        summaryToggle.setAttribute('aria-expanded', String(summaryExpanded));
      });
    }
  }

  formatImportedDescription(document.querySelector('[data-product-description-richtext]'));

  const menuToggle = document.querySelector('[data-menu-toggle]');
  const mobileMenu = document.querySelector('[data-mobile-menu]');
  const filterToggle = document.querySelector('[data-filter-toggle]');
  const filterClose = document.querySelector('[data-filter-close-mobile]');
  const filterSidebar = document.querySelector('[data-filter-sidebar-mobile]');
  const mobileFiltersQuery = window.matchMedia('(max-width: 1024px)');

  const predictiveSearchForms = Array.from(document.querySelectorAll('[data-predictive-search-form]'));

  predictiveSearchForms.forEach((form) => {
    const input = form.querySelector('[data-predictive-search-input]');
    const results = form.querySelector('[data-predictive-search-results]');

    if (!input || !results) return;

    let activeIndex = -1;
    let activeLinks = [];
    let abortController = null;

    const closeResults = () => {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }

      activeIndex = -1;
      activeLinks = [];
      results.hidden = true;
      results.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
    };

    const setActiveLink = (nextIndex) => {
      activeLinks.forEach((link, index) => {
        link.classList.toggle('is-active', index === nextIndex);
      });
      activeIndex = nextIndex;
    };

    const renderResults = (markup) => {
      results.innerHTML = markup.trim();
      activeLinks = Array.from(results.querySelectorAll('[data-predictive-search-link]'));
      activeIndex = -1;
      results.hidden = activeLinks.length === 0 && !results.textContent.trim();
      input.setAttribute('aria-expanded', String(!results.hidden));
    };

    const fetchResults = debounce(async () => {
      const query = input.value.trim();

      if (query.length < 2) {
        closeResults();
        return;
      }

      if (abortController) abortController.abort();
      abortController = new AbortController();

      try {
        const root = window.Shopify?.routes?.root || '/';
        const url = new URL(`${root}search/suggest.json`, window.location.origin);
        url.searchParams.set('q', query);
        url.searchParams.set('resources[type]', 'product,collection,query');
        url.searchParams.set('resources[limit]', '4');
        url.searchParams.set('resources[limit_scope]', 'each');
        url.searchParams.set('resources[options][unavailable_products]', 'hide');
        url.searchParams.set('resources[options][fields]', 'title,product_type,variants.title,vendor');

        const response = await fetch(url.toString(), {
          signal: abortController.signal,
          headers: {
            Accept: 'application/json'
          }
        });

        if (!response.ok) throw new Error(`Predictive search failed: ${response.status}`);

        const payload = await response.json();
        const resources = payload.resources?.results || {};
        renderResults(
          buildPredictiveSearchMarkup({
            query,
            queries: Array.isArray(resources.queries) ? resources.queries : [],
            collections: Array.isArray(resources.collections) ? resources.collections : [],
            products: Array.isArray(resources.products) ? resources.products : []
          })
        );
      } catch (error) {
        if (error.name === 'AbortError') return;
        closeResults();
      } finally {
        abortController = null;
      }
    }, 180);

    input.addEventListener('input', () => {
      fetchResults();
    });

    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2 && results.innerHTML.trim()) {
        results.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      }
    });

    input.addEventListener('keydown', (event) => {
      if (results.hidden || activeLinks.length === 0) {
        if (event.key === 'Escape') closeResults();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveLink((activeIndex + 1) % activeLinks.length);
        activeLinks[activeIndex].focus();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const nextIndex = activeIndex <= 0 ? activeLinks.length - 1 : activeIndex - 1;
        setActiveLink(nextIndex);
        activeLinks[activeIndex].focus();
        return;
      }

      if (event.key === 'Escape') {
        closeResults();
      }
    });

    results.addEventListener('keydown', (event) => {
      if (activeLinks.length === 0) return;

      const currentIndex = activeLinks.indexOf(document.activeElement);

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const nextIndex = (currentIndex + 1) % activeLinks.length;
        setActiveLink(nextIndex);
        activeLinks[nextIndex].focus();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (currentIndex <= 0) {
          setActiveLink(-1);
          input.focus();
        } else {
          const nextIndex = currentIndex - 1;
          setActiveLink(nextIndex);
          activeLinks[nextIndex].focus();
        }
        return;
      }

      if (event.key === 'Escape') {
        closeResults();
        input.focus();
      }
    });

    form.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!form.contains(document.activeElement)) {
          closeResults();
        }
      }, 120);
    });

    document.addEventListener('click', (event) => {
      if (!form.contains(event.target)) {
        closeResults();
      }
    });
  });

  if (menuToggle && mobileMenu) {
    let hideMenuTimer = null;

    menuToggle.addEventListener('click', () => {
      const expanded = menuToggle.getAttribute('aria-expanded') === 'true';

      if (hideMenuTimer) {
        window.clearTimeout(hideMenuTimer);
        hideMenuTimer = null;
      }

      if (expanded) {
        menuToggle.setAttribute('aria-expanded', 'false');
        mobileMenu.classList.remove('is-open');
        hideMenuTimer = window.setTimeout(() => {
          mobileMenu.hidden = true;
          hideMenuTimer = null;
        }, 220);
      } else {
        mobileMenu.hidden = false;
        window.requestAnimationFrame(() => {
          menuToggle.setAttribute('aria-expanded', 'true');
          mobileMenu.classList.add('is-open');
        });
      }
    });
  }

  if (filterToggle && filterSidebar) {
    const syncFilterState = (isOpen) => {
      filterSidebar.hidden = !isOpen;
      filterSidebar.classList.toggle('is-open', isOpen);
      filterToggle.setAttribute('aria-expanded', String(isOpen));
    };

    filterToggle.addEventListener('click', () => {
      if (!mobileFiltersQuery.matches) return;
      syncFilterState(!filterSidebar.classList.contains('is-open'));
    });

    const resetFiltersForViewport = (event) => {
      if (!event.matches) {
        syncFilterState(false);
      }
    };

    if (typeof mobileFiltersQuery.addEventListener === 'function') {
      mobileFiltersQuery.addEventListener('change', resetFiltersForViewport);
    } else if (typeof mobileFiltersQuery.addListener === 'function') {
      mobileFiltersQuery.addListener(resetFiltersForViewport);
    }
  }

    if (filterClose && filterSidebar) {
    filterClose.addEventListener('click', () => {
      syncFilterState(false);
    });
  }

  if (filterToggle && filterSidebar) {
    document.addEventListener('click', (event) => {
      if (!mobileFiltersQuery.matches) return;
      if (filterSidebar.hidden) return;
      if (filterToggle.contains(event.target) || filterSidebar.contains(event.target)) return;
      syncFilterState(false);
    });
  }

  document.querySelectorAll('[data-randomized-listing]').forEach((listing) => {
    const visibleCount = Number(listing.dataset.visibleCount || 0);
    const items = Array.from(listing.querySelectorAll('[data-randomized-item]'));

    if (!visibleCount || items.length <= visibleCount) return;

    const shuffledItems = shuffleArray(items);
    shuffledItems.forEach((item) => listing.appendChild(item));
    shuffledItems.forEach((item, index) => {
      item.hidden = index >= visibleCount;
    });
  });

  const productRoot = document.querySelector('[data-product-root]');
  if (!productRoot) return;

  const returnToSearchLink = document.querySelector('[data-return-to-search]');
  const productHandle = productRoot.dataset.productHandle;
  const listingContext = readSessionJson(listingContextKey);
  const productUrl = new URL(window.location.href);
  const explicitReturnSource = productUrl.searchParams.get('bt_source');
  const explicitReturnUrl = productUrl.searchParams.get('bt_return');
  const explicitReturnHandle = productUrl.searchParams.get('bt_handle');
  const currentProductPath = `${productUrl.pathname}${productUrl.search}`;

  let returnSearchUrl = '';
  let returnSearchHandle = '';

  if (
    explicitReturnSource === 'search' &&
    explicitReturnUrl &&
    explicitReturnHandle === productHandle &&
    isSearchReturnUrl(explicitReturnUrl) &&
    normalizePageUrl(explicitReturnUrl) !== normalizePageUrl(currentProductPath)
  ) {
    returnSearchUrl = explicitReturnUrl;
    returnSearchHandle = explicitReturnHandle;
  } else if (
    listingContext &&
    listingContext.sourceType === 'search' &&
    listingContext.productHandle === productHandle &&
    listingContext.url &&
    isSearchReturnUrl(listingContext.url) &&
    normalizePageUrl(listingContext.url) !== normalizePageUrl(currentProductPath)
  ) {
    returnSearchUrl = listingContext.url;
    returnSearchHandle = listingContext.productHandle;
  } else if (listingContext && listingContext.sourceType === 'search' && !isSearchReturnUrl(listingContext.url || '')) {
    removeSessionValue(listingContextKey);
  }

  if (
    returnToSearchLink &&
    productHandle &&
    returnSearchUrl &&
    returnSearchHandle === productHandle
  ) {
    returnToSearchLink.hidden = false;
    returnToSearchLink.href = returnSearchUrl;
    returnToSearchLink.addEventListener('click', (event) => {
      event.preventDefault();
      writeSessionJson(listingRestoreKey, {
        url: returnSearchUrl,
        productHandle: returnSearchHandle
      });
      window.location.href = returnSearchUrl;
    });
  }

  const moneyFormat = productRoot.dataset.moneyFormat || '${{amount}}';
  const zoomSurface = productRoot.querySelector('[data-product-zoom-surface]');
  const productImage = productRoot.querySelector('[data-product-image]');
  const magnifier = productRoot.querySelector('[data-product-magnifier]');
  const thumbs = productRoot.querySelectorAll('[data-product-thumb]');
  const prevMediaButton = productRoot.querySelector('[data-product-gallery-prev]');
  const nextMediaButton = productRoot.querySelector('[data-product-gallery-next]');
  const zoomOpen = productRoot.querySelector('[data-product-zoom-open]');
  const zoomModal = document.querySelector('[data-product-zoom]');
  const zoomImage = document.querySelector('[data-product-zoom-image]');
  const zoomCloseTriggers = document.querySelectorAll('[data-product-zoom-close]');
  const optionInputs = productRoot.querySelectorAll('[data-option-input]');
  const variantInput = productRoot.querySelector('[data-variant-id]');
  const addToCart = productRoot.querySelector('[data-add-to-cart]');
  const priceRoot = productRoot.querySelector('[data-product-price]');
  const saleCallout = productRoot.querySelector('[data-product-sale-callout]');
  const statusPill = productRoot.querySelector('[data-product-status-pill]');
  const variantsNode = productRoot.querySelector('[data-product-json]');
  const productCardNode = productRoot.querySelector('[data-product-card-json]');
  const variants = variantsNode ? JSON.parse(variantsNode.textContent) : [];
  const productCardData = productCardNode ? JSON.parse(productCardNode.textContent) : null;

  const formatMoney = (cents) => {
    return formatMoneyValue(cents, moneyFormat);
  };

  if (productCardData && productCardData.handle) {
    const recentItems = readRecentlyViewed().filter((item) => item.handle !== productCardData.handle);
    recentItems.unshift(productCardData);
    writeRecentlyViewed(recentItems.slice(0, 8));
  }

  const preloadImage = (src) => {
    if (!src) return;
    const image = new Image();
    image.src = src;
  };

  const syncZoomImage = (src, alt) => {
    if (!productImage) return;
    if (src) productImage.dataset.zoomImage = src;
    if (alt) productImage.alt = alt;
    if (magnifier) {
      magnifier.style.backgroundImage = `url("${productImage.dataset.zoomImage || productImage.src}")`;
    }
    if (zoomImage) {
      zoomImage.src = productImage.dataset.zoomImage || productImage.src;
      zoomImage.alt = productImage.alt || '';
    }
  };

  thumbs.forEach((thumb) => {
    preloadImage(thumb.dataset.image);
    preloadImage(thumb.dataset.zoomImage);
  });

  if (productImage) {
    syncZoomImage(productImage.dataset.zoomImage, productImage.alt);
  }

  let activeThumbIndex = Math.max(
    0,
    Array.from(thumbs).findIndex((thumb) => thumb.classList.contains('is-active'))
  );

  const setActiveThumb = (nextIndex) => {
    if (!thumbs.length) return;
    const normalizedIndex = ((nextIndex % thumbs.length) + thumbs.length) % thumbs.length;
    const thumb = thumbs[normalizedIndex];
    if (!thumb) return;

    thumbs.forEach((item) => item.classList.remove('is-active'));
    thumb.classList.add('is-active');
    activeThumbIndex = normalizedIndex;

    if (productImage) {
      productImage.src = thumb.dataset.image;
      syncZoomImage(thumb.dataset.zoomImage, thumb.dataset.imageAlt);
    }
  };

  thumbs.forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const thumbIndex = Array.from(thumbs).indexOf(thumb);
      setActiveThumb(thumbIndex);
    });
  });

  if (prevMediaButton && thumbs.length > 1) {
    prevMediaButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setActiveThumb(activeThumbIndex - 1);
    });
  }

  if (nextMediaButton && thumbs.length > 1) {
    nextMediaButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setActiveThumb(activeThumbIndex + 1);
    });
  }

  if (zoomSurface && productImage && magnifier && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const clearMagnifier = () => {
      zoomSurface.classList.remove('is-zooming');
    };

    zoomSurface.addEventListener('mousemove', (event) => {
      const rect = zoomSurface.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const xPercent = Math.min(Math.max((offsetX / rect.width) * 100, 0), 100);
      const yPercent = Math.min(Math.max((offsetY / rect.height) * 100, 0), 100);

      zoomSurface.classList.add('is-zooming');
      magnifier.style.backgroundPosition = `${xPercent}% ${yPercent}%`;
    });

    zoomSurface.addEventListener('mouseleave', clearMagnifier);
  }

  if (zoomOpen && zoomModal && zoomImage && productImage) {
    const openZoom = () => {
      syncZoomImage(productImage.dataset.zoomImage, productImage.alt);
      zoomModal.hidden = false;
      document.body.style.overflow = 'hidden';
    };

    zoomOpen.addEventListener('click', () => {
      openZoom();
    });

    if (zoomSurface) {
      zoomSurface.addEventListener('click', (event) => {
        if (event.target === zoomOpen || event.target.closest('[data-product-gallery-prev], [data-product-gallery-next]')) return;
        openZoom();
      });
    }

    zoomCloseTriggers.forEach((trigger) => {
      trigger.addEventListener('click', () => {
        zoomModal.hidden = true;
        document.body.style.overflow = '';
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !zoomModal.hidden) {
        zoomModal.hidden = true;
        document.body.style.overflow = '';
      }
    });
  }

  const syncVariant = () => {
    const selectedOptions = Array.from(optionInputs)
      .filter((input) => input.checked)
      .map((input) => input.value);

    const variant = variants.find((item) =>
      item.options.every((value, index) => value === selectedOptions[index])
    );

    if (!variant) return;

    if (variantInput) variantInput.value = variant.id;
    if (priceRoot) {
      if (variant.compare_at_price && variant.compare_at_price > variant.price) {
        priceRoot.innerHTML = `<div class="price"><span class="price__current">${formatMoney(variant.price)}</span><span class="price__compare">${formatMoney(variant.compare_at_price)}</span></div>`;
      } else {
        priceRoot.innerHTML = `<div class="price"><span class="price__current">${formatMoney(variant.price)}</span></div>`;
      }
    }
    if (saleCallout) {
      if (variant.compare_at_price && variant.compare_at_price > variant.price) {
        saleCallout.textContent = `Nice choice: save ${formatMoney(variant.compare_at_price - variant.price)} on this option.`;
        saleCallout.classList.remove('is-hidden');
      } else {
        saleCallout.textContent = '';
        saleCallout.classList.add('is-hidden');
      }
    }
    if (productImage && variant.featured_image && variant.featured_image.src) {
      const matchingThumbIndex = Array.from(thumbs).findIndex(
        (thumb) => thumb.dataset.image === variant.featured_image.src
      );

      if (matchingThumbIndex >= 0) {
        setActiveThumb(matchingThumbIndex);
      } else {
        productImage.src = variant.featured_image.src;
        syncZoomImage(variant.featured_image.src, productImage.alt);
      }
    }
    if (addToCart) {
      addToCart.disabled = !variant.available;
      addToCart.textContent = variant.available ? 'Add to basket' : 'Sold out';
    }
    if (statusPill) {
      statusPill.textContent = variant.available ? 'Ready to order' : 'Currently unavailable';
      statusPill.classList.toggle('product-status-pill--muted', !variant.available);
    }
  };

  optionInputs.forEach((input) => input.addEventListener('change', syncVariant));
});
