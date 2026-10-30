import { test, expect } from '@playwright/test';

test('checkout', async ({ page }) => {
  await page.goto('file://' + __dirname + '/../site/checkout.html');
  await page.fill(
    '#email',
    'ada@example.com'
  );
  await expect(page.getByText('Desk lamp')).toBeVisible();
  await page.getByRole('button', { name: 'Apply coupon' }).hover();
  await page.click(
    '#buy-now'
  );
  await expect(page.getByText(
    'Order confirmed')).toBeVisible();
});
