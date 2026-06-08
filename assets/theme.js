document.addEventListener('DOMContentLoaded', () => {
  const recentStorageKey = 'buy-that-thing:recently-viewed';
  const escapeHtml = (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

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

  const formatMoneyValue = (cents, moneyFormat = '${{amount}}') => {
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
  const filterClose = document.querySelector('[data-filter-close]');
  const filterSidebar = document.querySelector('[data-filter-sidebar]');

  if (menuToggle && mobileMenu) {
    menuToggle.addEventListener('click', () => {
      const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', String(!expanded));
      mobileMenu.hidden = expanded;
    });
  }

  if (filterToggle && filterSidebar) {
    filterToggle.addEventListener('click', () => filterSidebar.classList.add('is-open'));
  }

  if (filterClose && filterSidebar) {
    filterClose.addEventListener('click', () => filterSidebar.classList.remove('is-open'));
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

  const moneyFormat = productRoot.dataset.moneyFormat || '${{amount}}';
  const productImage = productRoot.querySelector('[data-product-image]');
  const thumbs = productRoot.querySelectorAll('[data-product-thumb]');
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

  thumbs.forEach((thumb) => {
    thumb.addEventListener('click', () => {
      thumbs.forEach((item) => item.classList.remove('is-active'));
      thumb.classList.add('is-active');
      if (productImage) productImage.src = thumb.dataset.image;
    });
  });

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
      productImage.src = variant.featured_image.src;
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
