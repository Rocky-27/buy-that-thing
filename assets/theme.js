document.addEventListener('DOMContentLoaded', () => {
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

  const productRoot = document.querySelector('[data-product-root]');
  if (!productRoot) return;

  const moneyFormat = productRoot.dataset.moneyFormat || '${{amount}}';
  const productImage = productRoot.querySelector('[data-product-image]');
  const thumbs = productRoot.querySelectorAll('[data-product-thumb]');
  const optionInputs = productRoot.querySelectorAll('[data-option-input]');
  const variantInput = productRoot.querySelector('[data-variant-id]');
  const addToCart = productRoot.querySelector('[data-add-to-cart]');
  const priceRoot = productRoot.querySelector('[data-product-price]');
  const variantsNode = productRoot.querySelector('[data-product-json]');
  const variants = variantsNode ? JSON.parse(variantsNode.textContent) : [];

  const formatMoney = (cents) => {
    const value = (Number(cents) / 100).toFixed(2);
    return moneyFormat.replace(/\{\{\s*amount\s*\}\}/, value);
  };

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
    if (productImage && variant.featured_image && variant.featured_image.src) {
      productImage.src = variant.featured_image.src;
    }
    if (addToCart) {
      addToCart.disabled = !variant.available;
      addToCart.textContent = variant.available ? 'Add to Basket' : 'Sold out';
    }
  };

  optionInputs.forEach((input) => input.addEventListener('change', syncVariant));
});
