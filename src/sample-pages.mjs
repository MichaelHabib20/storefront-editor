/**
 * Real addresses of each kind of page in a store's preview, for the editing AI to look at its change everywhere it
 * shows (it cannot guess a product's address). Read from the home page's links; a kind not found is left out.
 */
export function pagesFromHome(html) {
  const text = String(html ?? '');
  const product = text.match(/<a[^>]*ProductCard_link[^>]*href="(\/en\/[^"#?]+)"/)?.[1] ?? text.match(/<a[^>]*href="(\/en\/[^"#?]+)"[^>]*ProductCard_link/)?.[1] ?? null;
  const category = text.match(/href="(\/en\/product\/[^"#?/]+)"/)?.[1] ?? null;
  return {
    home: '/en',
    ...(category ? { category } : {}),
    ...(product ? { product } : {}),
    cart: '/en/cart',
    arabicHome: '/ar',
    ...(product ? { arabicProduct: product.replace(/^\/en\//, '/ar/') } : {}),
  };
}

/** The pages as lines for the AI's instructions. */
export function pagesText(pages) {
  const names = { home: 'home', category: 'a category', product: 'a product page', cart: 'the cart (empty until something is added)', arabicHome: 'Arabic home', arabicProduct: 'an Arabic product page' };
  return Object.entries(pages ?? {})
    .map(([kind, path]) => `  - ${names[kind] ?? kind}: ${path}`)
    .join('\n');
}

export async function samplePages(baseUrl) {
  try {
    const response = await fetch(new URL('/en', baseUrl), { signal: AbortSignal.timeout(60_000) });
    return pagesFromHome(await response.text());
  } catch {
    return pagesFromHome('');
  }
}
